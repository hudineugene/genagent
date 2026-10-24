import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";
import { loadKnowledge } from "@/lib/kb/store";

/** Модель для выжимки — самая дешёвая (та же, что у агентов студии): задача короткая. */
const SUMMARY_MODEL = "claude-haiku-5-5";
const HISTORY = 30;

/**
 * Выжимка разговора для менеджера, которому агент передал клиента: 2–4 строки — что клиент ищет,
 * какие параметры назвал, что уже обсудили и чего он ждёт от менеджера. null — не получилось (не мешает передаче).
 */
async function handoffSummary__(
  conversationId: string,
  ctx: { agentId: string; clientId: string; kbSourceIds?: string[] | null; language?: string },
): Promise<{ summary: string | null; draft: string | null }> {
  const key = apiKey("anthropic");
  if (!key) return { summary: null, draft: null };
  try {
    const rows = await db
      .select({ role: messages.role, text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent")))
      .orderBy(desc(messages.createdAt), desc(sql`rowid`))
      .limit(HISTORY);
    const dialog = rows
      .reverse()
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : m.role === "bot" ? "Бот" : "Агент"}: ${m.text.slice(0, 1500)}`)
      .join("\n");
    if (!dialog) return { summary: null, draft: null };
    // База знаний для черновика ответа: что агент знает по вопросам клиента
    const asked = rows.filter((m) => m.role === "user").map((m) => m.text).reverse().slice(-3);
    const kb = await loadKnowledge(ctx.clientId, ctx.kbSourceIds, asked).catch(() => ({ mode: "none" as const }));
    const kbText =
      kb.mode === "full"
        ? kb.docs.map((d) => `## ${d.title}\n${d.content}`).join("\n\n")
        : kb.mode === "search"
          ? [...(kb.pinned ?? []).map((d) => `## ${d.title}\n${d.content}`), kb.context ?? ""].filter(Boolean).join("\n\n")
          : "";

    const started = Date.now();
    const { data, usage, model } = await generateJson<{ wants: string; discussed: string; expects: string; draft: string }>(key, SUMMARY_MODEL, {
      system:
        "Ты готовишь короткую выжимку переписки для менеджера, которому ИИ-агент только что передал клиента. Пиши всегда по-русски, даже если переписка на другом языке. Три поля, каждое — одна короткая фраза до 120 символов, без вводных слов: wants — что клиент ищет (объект или услуга и параметры, которые он сам назвал: бюджет, сроки, спальни, район, имя, телефон); discussed — главное, что агент уже ответил (цифры, варианты); expects — что клиент ждёт от менеджера прямо сейчас. Только факты из переписки, ничего не додумывай; если чего-то нет — не упоминай. " +
        `Ещё поле draft — черновик ответа менеджера клиенту${ctx.language ? ` на языке «${ctx.language}»` : " на языке клиента"}: 1–3 предложения от лица компании. Если ответ есть в базе знаний или переписке — ответь по существу; если нет — вежливо скажи, что уточняете, и при необходимости задай 1 вопрос, который нужен менеджеру. Никогда не переспрашивай то, что клиент уже сказал в переписке (бюджет — в том числе «до 1 млн», параметры, район, сроки, имя, контакт): используй это в ответе. Если всё нужное уже известно — вопрос не задавай. Не обещай цен, сроков и действий, которых нет в базе знаний. Без markdown.`,
      prompt: `Переписка:\n${dialog}${kbText ? `\n\nБаза знаний компании:\n${kbText.slice(0, 14000)}` : ""}`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["wants", "discussed", "expects", "draft"],
        properties: { wants: { type: "string" }, discussed: { type: "string" }, expects: { type: "string" }, draft: { type: "string" } },
      },
      effort: "low",
    });
    await logUsage({ source: "channel", model, usage, agentId: ctx.agentId, clientId: ctx.clientId, conversationId, ms: Date.now() - started }).catch(() => {});
    const line = (label: string, v: string) => (v?.trim() ? `${label}: ${v.trim().replace(/\s+/g, " ").slice(0, 200)}` : "");
    const summary = [line("Ищет", data.wants), line("Обсудили", data.discussed), line("Ждёт от менеджера", data.expects)]
      .filter(Boolean)
      .join("\n");
    const draft = data.draft?.trim().slice(0, 1500) || null;
    return { summary: summary || null, draft: draft && draft.length >= 10 ? draft : null };
  } catch (e) {
    console.error("handoff summary failed", conversationId, e);
    return { summary: null, draft: null };
  }
}

/** handoffSummary — в области ключей клиента (его ключи ИИ, если заданы). */
export async function handoffSummary(...a: Parameters<typeof handoffSummary__>): ReturnType<typeof handoffSummary__> {
  return withKeys({ conversationId: a[0] }, () => handoffSummary__(...a));
}
