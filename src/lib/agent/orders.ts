import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations, messages, type ApiConfig, type Channel, type Conversation, type OrderState } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { agentMonthSpend, logUsage } from "@/lib/usage";
import { studioTz } from "@/lib/general";

/**
 * Агент сопровождает заказ. Свой бот сообщает о смене статуса (POST /order): GenAgent запоминает ленту
 * заказа (агент видит её в контексте и отвечает на «где мой заказ?» точно) и, если в канале включено
 * «Агент сопровождает заказ», дешёвая модель пишет клиенту живое сообщение вместо шаблона бота —
 * с учётом разговора. Факты (номер, сроки, суммы) — только из шаблона и данных бота: если в тексте
 * агента не хватает хоть одного числа из шаблона, возвращаем null и бот шлёт свой шаблон.
 */
const MODEL = "claude-haiku-5-5";
const KEEP_ORDERS = 5;
const KEEP_STEPS = 8;
/** Пишем живой текст лишь тем, кто разговаривал с агентом за последний месяц */
const TALK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LANGS: Record<string, string> = { ru: "русский", uk: "українська", en: "English", es: "español" };

export type OrderUpdate = { id: string; title?: string; status: string; label: string; facts?: string };

/** Запомнить новый статус заказа в разговоре (последние 5 заказов, у каждого — до 8 шагов). */
export function withOrder(orders: OrderState[] | undefined, u: OrderUpdate, at = Date.now()): OrderState[] {
  const list = [...(orders ?? [])];
  const i = list.findIndex((o) => o.id === u.id);
  const prev = i >= 0 ? list.splice(i, 1)[0] : undefined;
  const same = prev && prev.status === u.status;
  const next: OrderState = {
    id: u.id,
    title: u.title || prev?.title || "",
    status: u.status,
    label: u.label,
    facts: u.facts ?? prev?.facts ?? "",
    at,
    steps: same ? prev.steps : [...(prev?.steps ?? []), { label: u.label, at }].slice(-KEEP_STEPS),
  };
  return [next, ...list].slice(0, KEEP_ORDERS);
}

const fmt = (ms: number) =>
  new Date(ms).toLocaleString("ru-RU", { timeZone: studioTz(), day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Раздел контекста агента: заказы клиента по данным бота. */
export function ordersNote(orders: OrderState[] | undefined): string | undefined {
  if (!orders?.length) return undefined;
  const lines = orders.map((o) => {
    const path = o.steps.map((s) => `${s.label} (${fmt(s.at)})`).join(" → ");
    return `• ${o.title ? `«${o.title}» ` : ""}(${o.id}): сейчас — ${o.label}.${o.facts ? ` ${o.facts}.` : ""}${path ? ` История: ${path}.` : ""}`;
  });
  return `# Заказы и заявки клиента (данные бота, точные)\nНа вопросы «где мой заказ», «что с моей заявкой», «когда просмотр» отвечай по этим данным. Не обещай сроков и сумм, которых здесь нет.\n${lines.join("\n")}`;
}

/** Все числа шаблона (номер, даты, суммы) должны остаться в тексте агента. */
export function keepsFacts(fallback: string, text: string): boolean {
  const nums = (s: string) => (s.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((n) => n.replace(/[.,:]/g, "").replace(/^0+(?=\d)/, ""));
  const have = new Set(nums(text));
  return nums(fallback).every((n) => have.has(n));
}

/**
 * Живой текст о смене статуса или null (выключено, нет разговора с агентом, менеджер ведёт диалог,
 * бюджет исчерпан, модель не ответила или потеряла факты) — тогда бот шлёт свой шаблон.
 */
async function writeOrderNote__(
  channel: Pick<Channel, "id" | "agentId" | "clientId" | "config">,
  conversation: Conversation,
  u: OrderUpdate,
  fallback: string,
): Promise<string | null> {
  const key = apiKey("anthropic") ?? "";
  const cfg = channel.config as ApiConfig;
  if (!key || !cfg.orderNotes || conversation.mode !== "ai" || !fallback.trim()) return null;
  const [agent] = await db
    .select({ id: agents.id, status: agents.status, config: agents.config, client: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, channel.agentId));
  if (!agent || agent.status !== "active") return null;
  const agentCfg = agent.config as { replyLanguage?: string; toneCustom?: string; monthlyBudgetUsd?: number | null };
  if (agentCfg.monthlyBudgetUsd != null && (await agentMonthSpend(agent.id)) >= agentCfg.monthlyBudgetUsd) return null;

  const recent = await db
    .select({ role: messages.role, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.status, "sent")))
    .orderBy(desc(messages.createdAt))
    .limit(30);
  const dialog = recent.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "operator").reverse();
  if (!dialog.some((m) => m.role === "user" && Date.now() - m.createdAt.getTime() < TALK_WINDOW_MS)) return null;

  const lang = LANGS[conversation.context?.language ?? ""] ?? null;
  const started = Date.now();
  try {
    const { data, usage, model } = await generateJson<{ text: string }>(key, MODEL, {
      system: [
        `Ты — консультант компании «${agent.client}». У заказа клиента сменился статус, и бот собирается отправить шаблонное уведомление. Перепиши его как живое личное сообщение от тебя.`,
        "2–3 коротких предложения: что произошло с заказом и что будет дальше. Если в переписке есть детали заказа (что именно клиент заказывал, о чём просил, что волновало) — тепло упомяни одну, чтобы было видно, что ты помнишь. Без markdown, максимум одно эмодзи.",
        "Обязательно сохрани ВСЕ факты из шаблона: номер заказа, даты, время, суммы, адреса — те же цифры. Не добавляй новых обещаний, сроков, цен и действий, которых нет в шаблоне или данных заказа.",
        lang ? `Язык: ${lang}.` : agentCfg.replyLanguage && agentCfg.replyLanguage !== "auto" ? `Язык: ${LANGS[agentCfg.replyLanguage] ?? agentCfg.replyLanguage}.` : "Язык — тот, на котором написан шаблон.",
        agentCfg.toneCustom ? `Тон компании: ${agentCfg.toneCustom}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      prompt: [
        `Шаблон бота:\n${fallback.slice(0, 1500)}`,
        `Заказ ${u.id}${u.title ? ` «${u.title}»` : ""}: новый статус — ${u.label}.${u.facts ? ` ${u.facts}.` : ""}`,
        `Переписка с клиентом (последнее внизу):\n${dialog
          .slice(-12)
          .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Консультант"}: ${m.text.slice(0, 600)}`)
          .join("\n")}`,
      ].join("\n\n"),
      schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
      effort: "low",
    });
    await logUsage({ source: "channel", model, usage, agentId: agent.id, clientId: channel.clientId, conversationId: conversation.id, ms: Date.now() - started }).catch(() => {});
    const text = data.text.trim().slice(0, 1500);
    if (text.length < 10 || !keepsFacts(fallback, text)) return null;
    return text;
  } catch (e) {
    console.error("order note failed", conversation.id, e);
    return null;
  }
}

/** Сохранить ленту заказа и (если написали) сообщение агента в разговоре. */
export async function saveOrder(conversation: Conversation, u: OrderUpdate, note: string | null) {
  await db
    .update(conversations)
    .set({ context: { ...conversation.context, orders: withOrder(conversation.context?.orders, u) } })
    .where(eq(conversations.id, conversation.id));
  if (note) {
    await db.insert(messages).values({ conversationId: conversation.id, role: "assistant", text: note, status: "sent", meta: { orderNote: true } });
  }
}

/** writeOrderNote — в области ключей клиента (его ключи ИИ, если заданы). */
export async function writeOrderNote(...a: Parameters<typeof writeOrderNote__>): ReturnType<typeof writeOrderNote__> {
  return withKeys({ clientId: a[0].clientId }, () => writeOrderNote__(...a));
}
