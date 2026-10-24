import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, routingRules } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";

/**
 * Распределение заявок по специалистам: по причине передачи и выжимке разговора дешёвая модель выбирает тему
 * из правил клиента; уведомления получают только её ответственные. Выбор запоминается в разговоре — следующие
 * сообщения клиента и напоминания об ожидании идут тем же людям. Правил нет или тема не подошла — всем.
 */
const MODEL = "claude-haiku-5-5";

export async function rulesFor(clientId: string) {
  return db.select().from(routingRules).where(eq(routingRules.clientId, clientId)).orderBy(asc(routingRules.position), asc(routingRules.createdAt));
}

/** Выбрать тему и ответственных; null — правил нет, тема не подошла или у темы нет получателей. */
export async function pickRoute(clientId: string, text: string): Promise<{ rule: string; chatIds: string[] } | null> {
  const rules = (await rulesFor(clientId)).filter((r) => r.chatIds.length);
  if (!rules.length || !text.trim()) return null;
  if (rules.length === 1 && !rules[0].description.trim()) return { rule: rules[0].name, chatIds: rules[0].chatIds };
  return withKeys({ clientId }, async () => {
    const key = apiKey("anthropic");
    if (!key) return null;
    const started = Date.now();
    const { data, usage, model } = await generateJson<{ topic: string }>(key, MODEL, {
      system: [
        "Определи, к какой теме относится обращение клиента, чтобы отправить его нужному специалисту. Ответь названием темы ровно как в списке или «другое», если ни одна не подходит.",
        "Темы:",
        ...rules.map((r) => `- ${r.name}${r.description ? `: ${r.description}` : ""}`),
      ].join("\n"),
      prompt: text.slice(0, 4000),
      schema: { type: "object", additionalProperties: false, required: ["topic"], properties: { topic: { type: "string" } } },
      effort: "low",
    });
    await logUsage({ source: "insights", model, usage, clientId, ms: Date.now() - started }).catch(() => {});
    const t = data.topic.trim().toLowerCase();
    const r = rules.find((x) => x.name.trim().toLowerCase() === t) ?? rules.find((x) => t.includes(x.name.trim().toLowerCase()));
    return r ? { rule: r.name, chatIds: r.chatIds } : null;
  });
}

/** Назначить ответственных разговору (при передаче или горячем клиенте) — если ещё не назначены. */
export async function assignConversation(conversationId: string, clientId: string, text: string) {
  const [c] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversationId));
  if (c?.context?.assignedTo) return c.context.assignedTo;
  const route = await pickRoute(clientId, text).catch((e) => {
    console.error("routing failed", e);
    return null;
  });
  if (!route) return null;
  const assignedTo = { ...route, at: Date.now() };
  await db.update(conversations).set({ context: { ...c?.context, assignedTo } }).where(eq(conversations.id, conversationId));
  return assignedTo;
}
