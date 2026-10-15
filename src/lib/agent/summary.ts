import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/** Модель для выжимки — самая дешёвая (та же, что у агентов студии): задача короткая. */
const SUMMARY_MODEL = "claude-haiku-5-5";
const HISTORY = 30;

/**
 * Выжимка разговора для менеджера, которому агент передал клиента: 2–4 строки — что клиент ищет,
 * какие параметры назвал, что уже обсудили и чего он ждёт от менеджера. null — не получилось (не мешает передаче).
 */
export async function handoffSummary(conversationId: string, ctx: { agentId: string; clientId: string }): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
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
      .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Агент"}: ${m.text.slice(0, 1500)}`)
      .join("\n");
    if (!dialog) return null;

    const started = Date.now();
    const { data, usage, model } = await generateJson<{ wants: string; discussed: string; expects: string }>(key, SUMMARY_MODEL, {
      system:
        "Ты готовишь короткую выжимку переписки для менеджера, которому ИИ-агент только что передал клиента. Пиши всегда по-русски, даже если переписка на другом языке. Три поля, каждое — одна короткая фраза до 120 символов, без вводных слов: wants — что клиент ищет (объект или услуга и параметры, которые он сам назвал: бюджет, сроки, спальни, район, имя, телефон); discussed — главное, что агент уже ответил (цифры, варианты); expects — что клиент ждёт от менеджера прямо сейчас. Только факты из переписки, ничего не додумывай; если чего-то нет — не упоминай.",
      prompt: `Переписка:\n${dialog}`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["wants", "discussed", "expects"],
        properties: { wants: { type: "string" }, discussed: { type: "string" }, expects: { type: "string" } },
      },
      effort: "low",
    });
    await logUsage({ source: "channel", model, usage, agentId: ctx.agentId, clientId: ctx.clientId, conversationId, ms: Date.now() - started }).catch(() => {});
    const line = (label: string, v: string) => (v?.trim() ? `${label}: ${v.trim().replace(/\s+/g, " ").slice(0, 200)}` : "");
    const summary = [line("Ищет", data.wants), line("Обсудили", data.discussed), line("Ждёт от менеджера", data.expects)]
      .filter(Boolean)
      .join("\n");
    return summary || null;
  } catch (e) {
    console.error("handoff summary failed", conversationId, e);
    return null;
  }
}
