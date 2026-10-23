import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations, messages } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import type { ChatMessage } from "@/lib/llm";
import { logUsage } from "@/lib/usage";
import { agentConfigSchema } from "./types";
import { prepareChat } from "./runtime";

/**
 * Контроль качества ответов живых сотрудников: дешёвая модель смотрит ответ менеджера клиенту по тем же правилам
 * и базе знаний, что и агента, — ответил ли по сути, нет ли неверных фактов, обещаний, которые компания не даёт,
 * резкого тона, понятен ли следующий шаг. Оценка 1–10, замечания и улучшенный вариант (на языке клиента).
 * Автоматически — после отправки (если включено у агента); вручную — кнопкой «Проверить ответ» до отправки.
 */
const MODEL = "claude-haiku-5-5";

export type OperatorReview = { score: number; problems: string[]; better: string };

async function context(conversationId: string) {
  const [row] = await db
    .select({ conversation: conversations, agent: agents, client: clients })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .where(eq(conversations.id, conversationId));
  if (!row) return null;
  const config = agentConfigSchema.safeParse(row.agent.config);
  if (!config.success) return null;
  return { ...row, config: config.data };
}

/** Оценить ответ сотрудника. history — разговор до этого ответа (последнее — сообщение клиента). */
export async function reviewReply(conversationId: string, reply: string, history?: ChatMessage[]): Promise<OperatorReview | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const ctx = await context(conversationId);
  if (!apiKey || !ctx) return null;
  const dialog =
    history ??
    (
      await db
        .select({ role: messages.role, text: messages.text })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"])))
        .orderBy(asc(messages.createdAt))
    )
      .slice(-12)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.text }));
  // Та же инструкция и найденные фрагменты базы знаний, что видел бы агент
  const prepared = await prepareChat(ctx.config, { ...ctx.client, id: ctx.client.id }, dialog, { mode: "dry", agentId: ctx.agent.id });
  const talk = prepared.messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Клиент" : "Компания"}: ${m.content.slice(-6000)}`)
    .join("\n\n");
  const started = Date.now();
  const { data, usage, model } = await generateJson<OperatorReview>(apiKey, MODEL, {
    system: [
      "Ты проверяешь ответ сотрудника компании клиенту в чате. Тебе даны инструкция ИИ-консультанта компании (правила, тон и база знаний — по ним работает и сотрудник), разговор и ответ сотрудника.",
      "Оцени по сути, без придирок к стилю:",
      "1) ответил ли на то, что спросил клиент;",
      "2) нет ли фактов, которые противоречат базе знаний (цены, наличие, сроки, условия), и обещаний, которых компания не даёт;",
      "3) тон: нет ли резкости, раздражения, пренебрежения;",
      "4) понятен ли клиенту следующий шаг.",
      "score — 1–10 (10 — отличный ответ). problems — короткие конкретные замечания (пусто, если ответ хороший). better — улучшенный ответ целиком на языке клиента, коротко и по-человечески, только если есть замечания; иначе пустая строка. Не выдумывай фактов, которых нет в базе знаний и разговоре.",
    ].join("\n"),
    prompt: `Инструкция консультанта:\n${prepared.system.slice(0, 50_000)}\n\nРазговор:\n${talk}\n\nОтвет сотрудника:\n${reply}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["score", "problems", "better"],
      properties: { score: { type: "integer" }, problems: { type: "array", items: { type: "string" } }, better: { type: "string" } },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId: ctx.agent.id, clientId: ctx.client.id, conversationId, ms: Date.now() - started }).catch(() => {});
  const problems = (data.problems ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 5);
  return { score: Math.max(1, Math.min(10, Math.round(data.score))), problems, better: problems.length ? data.better.trim().slice(0, 4000) : "" };
}

/** После отправки: оценить сообщение сотрудника, если у агента включён контроль качества. */
export async function reviewOperatorMessage(messageId: string) {
  try {
    const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
    if (!m || m.role !== "operator" || !m.text.trim() || m.meta?.operatorReview) return;
    const ctx = await context(m.conversationId);
    if (!ctx?.config.operatorReview || ctx.conversation.isTest) return;
    const before = (
      await db
        .select({ id: messages.id, role: messages.role, text: messages.text })
        .from(messages)
        .where(and(eq(messages.conversationId, m.conversationId), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"])))
        .orderBy(asc(messages.createdAt))
    );
    const i = before.findIndex((x) => x.id === m.id);
    const history = before
      .slice(0, i < 0 ? before.length : i)
      .slice(-12)
      .map((x) => ({ role: x.role === "user" ? ("user" as const) : ("assistant" as const), content: x.text }));
    if (!history.some((h) => h.role === "user")) return;
    const r = await reviewReply(m.conversationId, m.text, history);
    if (!r) return;
    const [fresh] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, m.id));
    await db.update(messages).set({ meta: { ...fresh?.meta, operatorReview: r } }).where(eq(messages.id, m.id));
  } catch (e) {
    console.error("operator review failed", messageId, e);
  }
}
