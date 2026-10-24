import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { agents, conversations, kbSources, knowledgeGaps, messages } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { getSetting, setSetting } from "@/lib/settings";
import { logUsage } from "@/lib/usage";
import { ANSWERS_TITLE } from "./kb-answers";

/**
 * Агент учится на ответах менеджера. Раз в 10 минут: свежие ответы сотрудников клиентам (из «Диалогов», Telegram
 * или журнала бота). Дешёвая модель решает, есть ли в ответе знание, полезное и другим клиентам (цены, сроки,
 * условия, как устроена услуга), — а не личное («ваш заказ готов»). Если есть — пара «вопрос — ответ» становится
 * предложением в «Вопросах без ответа», а сотрудникам в Telegram приходит «Добавить в базу знаний?» с кнопкой.
 * Одно нажатие — и в следующий раз агент ответит сам.
 */
const MODEL = "claude-haiku-5-5";
const CURSOR_KEY = "learnCursor";
/** Ответ менеджера берём, когда он отписался (5 минут тишины от сотрудника) — часто отвечают в несколько сообщений */
const SETTLE_MS = 5 * 60 * 1000;
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const PER_RUN = 15;
const MIN_ANSWER = 15;

type Proposal = { useful: boolean; question: string; answer: string; matchId: string | null };

/** Возвращает id новых/обновлённых предложений (для уведомлений). */
export async function runLearning(): Promise<string[]> {
  const key = apiKey("anthropic") ?? "";
  if (!key) return [];
  const now = Date.now();
  const cursor = (await getSetting<number>(CURSOR_KEY)) ?? now - FIRST_LOOKBACK_MS;
  const until = now - SETTLE_MS;
  const fresh = await db
    .select({ id: messages.id, conversationId: messages.conversationId, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    // тестовые разговоры — не учимся на них
    .where(
      and(
        eq(messages.role, "operator"),
        eq(messages.status, "sent"),
        eq(conversations.isTest, false),
        gt(messages.createdAt, new Date(cursor)),
        lt(messages.createdAt, new Date(until)),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(200);
  // По разговору — последний ответ сотрудника в окне; разговоры без существенного ответа пропускаем
  const byConv = new Map<string, { at: number }>();
  for (const m of fresh) if (m.text.trim().length >= MIN_ANSWER) byConv.set(m.conversationId, { at: m.createdAt.getTime() });
  const proposals: string[] = [];
  let done = 0;
  let reached = cursor;
  for (const [conversationId, { at }] of byConv) {
    if (done >= PER_RUN) break;
    done++;
    reached = Math.max(reached, at);
    const id = await learnFrom(key, conversationId, at).catch((e) => {
      console.error("learn failed", conversationId, e);
      return null;
    });
    if (id) proposals.push(id);
  }
  // Курсор — до последнего разобранного (или до конца окна, если разобрали всё)
  await setSetting(CURSOR_KEY, done >= PER_RUN ? reached : Math.max(cursor, until));
  return proposals;
}

async function learnFrom__(key: string, conversationId: string, at: number): Promise<string | null> {
  const [row] = await db
    .select({ conversation: conversations, agentStatus: agents.status, agentName: agents.name })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(eq(conversations.id, conversationId));
  if (!row || row.agentStatus !== "active" || row.conversation.kind !== "dm") return null;
  const c = row.conversation;
  const history = await db
    .select({ role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"]), lt(messages.createdAt, new Date(at + 1000))))
    .orderBy(desc(messages.createdAt))
    .limit(16);
  const dialog = history.reverse();
  if (!dialog.some((m) => m.role === "user")) return null;
  const gaps = await db
    .select({ id: knowledgeGaps.id, question: knowledgeGaps.question, status: knowledgeGaps.status })
    .from(knowledgeGaps)
    .where(eq(knowledgeGaps.agentId, c.agentId))
    .orderBy(desc(knowledgeGaps.lastSeenAt))
    .limit(60);
  const [faq] = await db
    .select({ content: kbSources.content })
    .from(kbSources)
    .where(and(eq(kbSources.clientId, c.clientId), eq(kbSources.title, ANSWERS_TITLE)));

  const started = Date.now();
  const { data, usage, model } = await generateJson<Proposal>(key, MODEL, {
    system: [
      "Ты помогаешь ИИ-агенту компании учиться у менеджеров. В переписке менеджер ответил клиенту вместо агента.",
      "Реши, есть ли в ответе менеджера знание, которое пригодится и другим клиентам: цены, сроки, условия, как устроена услуга, где что находится, правила. Тогда useful=true: сформулируй общий вопрос клиента (одной фразой, без имён и личных деталей) и ответ для базы знаний (2–4 предложения, только факты из ответа менеджера, без приветствий и обращений по имени).",
      "useful=false, если ответ личный или разовый (статус конкретного заказа, «перезвоню», «уточню», «спасибо», договорённость о встрече), если знание уже есть в «Уже в базе знаний» или если менеджер ничего не сообщил по существу.",
      "Если вопрос по смыслу совпадает с одним из «Известных вопросов» — верни его id в matchId, иначе null. Пиши по-русски.",
    ].join("\n"),
    prompt: [
      `Переписка (последнее внизу):\n${dialog
        .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Агент"}: ${m.text.slice(0, 800)}${m.meta?.vision ? ` [фото: ${m.meta.vision.slice(0, 150)}]` : ""}`)
        .join("\n")}`,
      gaps.length ? `Известные вопросы:\n${gaps.map((g) => `${g.id} [${g.status}]: ${g.question}`).join("\n")}` : "Известных вопросов нет.",
      faq?.content ? `Уже в базе знаний (фрагмент):\n${faq.content.slice(-4000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["useful", "question", "answer", "matchId"],
      properties: { useful: { type: "boolean" }, question: { type: "string" }, answer: { type: "string" }, matchId: { type: ["string", "null"] } },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId: c.agentId, clientId: c.clientId, conversationId, ms: Date.now() - started }).catch(() => {});
  const question = data.question.trim().slice(0, 300);
  const answer = data.answer.trim().slice(0, 2000);
  if (!data.useful || question.length < 5 || answer.length < 10) return null;
  const quote = dialog.filter((m) => m.role === "user").at(-1)?.text.slice(0, 300) ?? question;
  const example = { conversationId, quote, at };
  const match = data.matchId ? gaps.find((g) => g.id === data.matchId) : undefined;
  if (match) {
    // Уже решённый или скрытый вопрос — не предлагаем снова
    if (match.status !== "open") return null;
    const [g] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, match.id));
    await db
      .update(knowledgeGaps)
      .set({ suggestion: answer, count: g.count + 1, lastSeenAt: new Date(at), examples: [...(g.examples ?? []), example].slice(-5) })
      .where(eq(knowledgeGaps.id, match.id));
    return match.id;
  }
  const [created] = await db
    .insert(knowledgeGaps)
    .values({ agentId: c.agentId, clientId: c.clientId, question, suggestion: answer, examples: [example], lastSeenAt: new Date(at) })
    .returning({ id: knowledgeGaps.id });
  return created.id;
}

export function startLearning() {
  const g = globalThis as unknown as { __learnTimer?: ReturnType<typeof setInterval> };
  if (g.__learnTimer) return;
  const run = async () => {
    try {
      const ids = await runLearning();
      if (ids.length) {
        const { notifyLearned } = await import("@/lib/notify/telegram");
        for (const id of ids) await notifyLearned(id);
      }
    } catch (e) {
      console.error("learning run failed", e);
    }
  };
  setTimeout(run, 4 * 60_000).unref?.();
  g.__learnTimer = setInterval(run, 10 * 60_000);
  g.__learnTimer.unref?.();
}

/** learnFrom — в области ключей клиента (его ключи ИИ, если заданы). */
async function learnFrom(...a: Parameters<typeof learnFrom__>): ReturnType<typeof learnFrom__> {
  return withKeys({ conversationId: a[1] }, () => learnFrom__(...a));
}
