import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, conversations, knowledgeGaps, messages } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { getSetting, setSetting } from "@/lib/settings";
import { logUsage } from "@/lib/usage";

/**
 * «Вопросы без ответа»: раз в сутки дешёвая модель просматривает новые переписки агента и находит вопросы,
 * на которые агент не смог ответить по существу из-за нехватки информации. Похожие склеиваются с уже найденными.
 */
const MODEL = "claude-haiku-5-5";
const MAX_EXCHANGES = 120;
const FIRST_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const CURSOR_KEY = "gapsCursor";

type Exchange = { conversationId: string; at: number; question: string; answer: string; handoff: boolean; operator?: string };

// Сотрудник часто отвечает через несколько часов после вопроса — вопрос ищем и до начала разбора.
const OPERATOR_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Пары «сообщение клиента → ответ агента» с момента since. Если после агента (или вместо него, пока разговор
 * вёл человек) клиенту ответил сотрудник — его ответ тоже в паре: из него можно взять ответ для базы знаний.
 */
async function exchangesSince(agentId: string, since: number): Promise<Exchange[]> {
  // тестовые разговоры — не в счёт
  const convs = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false)));
  if (!convs.length) return [];
  const rows = await db
    .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, status: messages.status, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), gt(messages.createdAt, new Date(since - OPERATOR_LOOKBACK_MS))))
    .orderBy(asc(messages.createdAt));
  const out: Exchange[] = [];
  const pending = new Map<string, string[]>();
  const last = new Map<string, Exchange>(); // последняя пара разговора — к ней пристёгиваем ответ сотрудника
  for (const m of rows) {
    if (m.role === "user") {
      pending.set(m.conversationId, [...(pending.get(m.conversationId) ?? []), m.text]);
    } else if (m.role === "assistant" && m.status !== "rejected") {
      const q = pending.get(m.conversationId);
      if (!q?.length) continue;
      pending.delete(m.conversationId);
      const e: Exchange = {
        conversationId: m.conversationId,
        at: m.createdAt.getTime(),
        question: q.join("\n").slice(0, 800),
        answer: m.text.slice(0, 1200),
        handoff: Boolean(m.meta?.handoff),
      };
      out.push(e);
      last.set(m.conversationId, e);
    } else if (m.role === "operator" && m.status === "sent" && m.text.trim().length >= 15) {
      const q = pending.get(m.conversationId);
      const prev = last.get(m.conversationId);
      if (q?.length) {
        // Разговор вёл сотрудник — агент на вопрос не отвечал.
        pending.delete(m.conversationId);
        const e: Exchange = { conversationId: m.conversationId, at: m.createdAt.getTime(), question: q.join("\n").slice(0, 800), answer: "", handoff: true, operator: m.text.slice(0, 1200) };
        out.push(e);
        last.set(m.conversationId, e);
      } else if (prev && m.createdAt.getTime() - prev.at < OPERATOR_LOOKBACK_MS) {
        prev.operator = [prev.operator, m.text].filter(Boolean).join("\n").slice(0, 1200);
        prev.at = Math.max(prev.at, m.createdAt.getTime());
      }
    }
  }
  return out.filter((e) => e.at > since).slice(-MAX_EXCHANGES);
}

type Found = { question: string; missing: string; exchanges: number[]; matchId: string; suggestedAnswer: string };

/** Разобрать новые переписки агента. Возвращает, сколько найдено новых вопросов. */
export async function analyzeGaps(agentId: string): Promise<{ newGaps: number; updated: number; exchanges: number }> {
  const key = process.env.ANTHROPIC_API_KEY;
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!key || !agent) return { newGaps: 0, updated: 0, exchanges: 0 };
  const cursors = (await getSetting<Record<string, number>>(CURSOR_KEY)) ?? {};
  const since = cursors[agentId] ?? Date.now() - FIRST_LOOKBACK_MS;
  const list = await exchangesSince(agentId, since);
  const saveCursor = async () => setSetting(CURSOR_KEY, { ...((await getSetting<Record<string, number>>(CURSOR_KEY)) ?? {}), [agentId]: list.at(-1)?.at ?? Date.now() });
  if (!list.length) {
    await saveCursor();
    return { newGaps: 0, updated: 0, exchanges: 0 };
  }

  const open = await db
    .select({ id: knowledgeGaps.id, question: knowledgeGaps.question })
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.agentId, agentId), inArray(knowledgeGaps.status, ["open", "ignored"])));

  const started = Date.now();
  const { data, usage, model } = await generateJson<{ gaps: Found[] }>(key, MODEL, {
    system: [
      "Ты помогаешь улучшать базу знаний чат-агента компании. Перед тобой пары «вопрос клиента → ответ агента».",
      "Найди вопросы, на которые агент НЕ смог ответить по существу, потому что ему не хватило информации: ответил «уточню у менеджера», «информации нет», «в описании не указано», уклонился или передал менеджеру из-за незнания.",
      "НЕ включай: просьбы записаться, позвонить, позвать менеджера, торг о цене, оформление заказа, приветствия, болтовню и вопросы не по теме компании, а также вопросы, на которые агент ответил.",
      "Сюда же относятся вопросы, на которые вместо агента ответил сотрудник компании (строка «Сотрудник»), если в его ответе есть сведения, которых агент не дал.",
      "Для каждого вопроса: question — короткая обобщённая формулировка по-русски (как частый вопрос, без имён), missing — какой информации не хватает в базе знаний, exchanges — номера пар, где он встретился, matchId — id из списка уже известных вопросов, если это тот же вопрос по смыслу, иначе пустая строка.",
      "suggestedAnswer — если сотрудник ответил на этот вопрос сведениями, полезными и другим клиентам (условия, сроки, цены, адреса, порядок действий), — готовый короткий ответ для базы знаний на основе его слов, на языке ответа сотрудника, без имён, телефонов клиента и деталей конкретного заказа. Если сотрудник не отвечал, ответил только про конкретного клиента («ваш заказ готов») или «уточню» — пустая строка. Ничего не придумывай сверх сказанного сотрудником.",
      "Похожие вопросы объединяй в один. Если таких вопросов нет — верни пустой список.",
    ].join("\n"),
    prompt: `Уже известные вопросы:\n${open.map((g) => `${g.id}: ${g.question}`).join("\n") || "(нет)"}\n\nПары:\n${list
      .map(
        (e, i) =>
          `[${i}] Клиент: ${e.question}\nАгент${e.handoff ? " (передал менеджеру)" : ""}: ${e.answer || "(не отвечал — разговор вёл сотрудник)"}` +
          (e.operator ? `\nСотрудник: ${e.operator}` : ""),
      )
      .join("\n\n")}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["gaps"],
      properties: {
        gaps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["question", "missing", "exchanges", "matchId", "suggestedAnswer"],
            properties: {
              question: { type: "string" },
              missing: { type: "string" },
              exchanges: { type: "array", items: { type: "integer" } },
              matchId: { type: "string" },
              suggestedAnswer: { type: "string" },
            },
          },
        },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId, clientId: agent.clientId, ms: Date.now() - started }).catch(() => {});

  const known = new Set(open.map((g) => g.id));
  let newGaps = 0;
  let updated = 0;
  for (const g of data.gaps.slice(0, 30)) {
    const hits = g.exchanges.map((i) => list[i]).filter(Boolean);
    if (!hits.length || !g.question.trim()) continue;
    const examples = hits.slice(0, 3).map((e) => ({ conversationId: e.conversationId, quote: e.question.slice(0, 300), at: e.at }));
    // Ответ для базы знаний — только если в этих парах действительно отвечал сотрудник.
    const suggestion = hits.some((e) => e.operator) ? g.suggestedAnswer.trim().slice(0, 2000) || null : null;
    if (g.matchId && known.has(g.matchId)) {
      const [old] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, g.matchId));
      if (!old) continue;
      await db
        .update(knowledgeGaps)
        .set({
          count: old.count + hits.length,
          examples: [...examples, ...old.examples].slice(0, 5),
          lastSeenAt: new Date(),
          ...(suggestion ? { suggestion } : {}),
        })
        .where(eq(knowledgeGaps.id, old.id));
      updated++;
    } else {
      await db.insert(knowledgeGaps).values({
        agentId,
        clientId: agent.clientId,
        question: g.question.trim().slice(0, 300),
        missing: g.missing.trim().slice(0, 500),
        count: hits.length,
        examples,
        suggestion,
      });
      newGaps++;
    }
  }
  await saveCursor();
  return { newGaps, updated, exchanges: list.length };
}

/** Ежедневный разбор всех активных агентов; о новых вопросах — уведомление в Telegram. */
export function startGapsAnalysis() {
  const g = globalThis as unknown as { __gapsTimer?: ReturnType<typeof setInterval> };
  if (g.__gapsTimer) return;
  const run = async () => {
    const last = (await getSetting<number>("gapsLastRun")) ?? 0;
    if (Date.now() - last < RUN_EVERY_MS - 60_000) return;
    await setSetting("gapsLastRun", Date.now());
    const list = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.status, "active"));
    for (const a of list) {
      try {
        // Сначала закрыть вопросы, на которые база знаний уже отвечает (добавили документ)
        const { recheckGaps } = await import("./gaps-recheck");
        await recheckGaps(a.id).catch((e) => console.error("gaps recheck failed", a.id, e));
        const r = await analyzeGaps(a.id);
        if (r.newGaps) {
          const { notifyGaps } = await import("@/lib/notify/telegram");
          await notifyGaps(a.id, r.newGaps);
        }
      } catch (e) {
        console.error("gaps analysis failed", a.id, e);
      }
    }
  };
  setTimeout(() => void run(), 5 * 60_000).unref?.();
  g.__gapsTimer = setInterval(() => void run(), 60 * 60_000);
  g.__gapsTimer.unref?.();
}
