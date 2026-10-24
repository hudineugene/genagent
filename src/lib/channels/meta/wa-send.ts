import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, usageLog, type Channel, type Conversation, type WhatsAppConfig } from "@/db/schema";
import * as wa from "./whatsapp";

/**
 * Отправка в WhatsApp по правилам Meta: в течение 24 часов после последнего сообщения клиента — обычный текст;
 * позже — только утверждённым шаблоном (наш текст — в {{1}} выбранного шаблона). С 01.10.2026 платные и обычные
 * ответы — каждое исходящее сообщение записывается в расходы клиента по цене, заданной в канале.
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export class WaWindowError extends Error {
  constructor() {
    super("wa_window_closed");
  }
}

/** Открыто ли окно: последнее сообщение клиента не старше 24 часов. */
export async function windowOpen(conversationId: string, now = Date.now()) {
  const [last] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return Boolean(last && now - last.at.getTime() < WINDOW_MS);
}

async function logCost(channel: Channel, conversation: Conversation, kind: "service" | "template") {
  const cfg = channel.config as WhatsAppConfig;
  const cost = kind === "template" ? (cfg.price?.template ?? 0) : (cfg.price?.service ?? 0);
  await db
    .insert(usageLog)
    .values({ source: "channel", model: `whatsapp:${kind}`, agentId: channel.agentId, clientId: channel.clientId, conversationId: conversation.id ?? null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost, ms: 0 })
    .catch((e) => console.error("whatsapp cost log failed", e));
}

export async function sendWhatsApp(channel: Channel, conversation: Conversation, text: string): Promise<string | null> {
  const cfg = channel.config as WhatsAppConfig;
  const open = conversation.id ? await windowOpen(conversation.id) : true;
  if (open) {
    const id = await wa.sendText(cfg.token, cfg.phoneNumberId, conversation.externalId, text);
    await logCost(channel, conversation, "service");
    return id;
  }
  if (!cfg.proactiveTemplate) throw new WaWindowError();
  const tpl = cfg.templates?.find((t) => t.name === cfg.proactiveTemplate!.name && t.language === cfg.proactiveTemplate!.language);
  const id = await wa.sendTemplate(cfg.token, cfg.phoneNumberId, conversation.externalId, cfg.proactiveTemplate.name, cfg.proactiveTemplate.language, tpl && tpl.params === 0 ? [] : [text]);
  await logCost(channel, conversation, "template");
  return id;
}

/** Аудио (голосовой ответ) — тоже платное сообщение. */
export async function logWhatsAppAudio(channel: Channel, conversation: Conversation) {
  await logCost(channel, conversation, "service");
}
