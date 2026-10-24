import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, type Channel, type Conversation, type TelegramConfig, type WhatsAppConfig } from "@/db/schema";

/**
 * Голосовые в нативных Telegram и WhatsApp: входящее голосовое расшифровывается на сервере студии (без внешних
 * сервисов) и становится текстом сообщения; если клиент прислал голосовое и у агента включены голосовые ответы,
 * ответ озвучивается (OpenAI) и уходит голосовым, текст — подписью (Telegram) или следом (WhatsApp).
 */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

/** Подставить расшифровку в сообщение клиента. true — расшифровано. */
export async function transcribeIncoming(messageId: string, buf: Buffer, hint?: string) {
  const { AsrError, transcribeOgg } = await import("@/lib/asr");
  try {
    // ASR_TEST_TEXT — только для проверок без модели распознавания
    const r = process.env.ASR_TEST_TEXT ? { text: process.env.ASR_TEST_TEXT } : await transcribeOgg(new Uint8Array(buf), hint);
    const [cur] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
    await db
      .update(messages)
      .set({ text: r.text ? `🎤 ${r.text}` : "[голосовое: слов не разобрать]", meta: { ...cur?.meta, kind: "voice" } })
      .where(eq(messages.id, messageId));
    return Boolean(r.text);
  } catch (e) {
    if (!(e instanceof AsrError)) console.error("voice transcription failed", e);
    const [cur] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
    await db.update(messages).set({ meta: { ...cur?.meta, kind: "voice" } }).where(eq(messages.id, messageId));
    return false;
  }
}

/** Отвечать ли голосом: последнее сообщение клиента — голосовое, агент это разрешает, озвучка доступна. */
export function wantsVoice(channel: Pick<Channel, "type">, conversation: Pick<Conversation, "kind">, lastUserKind: string | undefined, voiceReplies: boolean | undefined) {
  return (channel.type === "telegram" || channel.type === "whatsapp") && conversation.kind === "dm" && lastUserKind === "voice" && voiceReplies !== false;
}

/** Озвучить ответ и отправить голосовым. null — не вышло (тогда отправляется обычный текст). */
export async function deliverVoice(
  channel: Pick<Channel, "type" | "config">,
  conversation: Pick<Conversation, "externalId" | "context" | "id">,
  text: string,
  opts: { voice?: string; agentId: string; clientId: string },
): Promise<{ externalId: string | null } | null> {
  const { speechAvailable, synthesize } = await import("@/lib/speech");
  if (!speechAvailable()) return null;
  const data = await synthesize(text, { voice: opts.voice, language: conversation.context?.language, agentId: opts.agentId, clientId: opts.clientId, conversationId: conversation.id });
  if (!data) return null;
  const ogg = Buffer.from(data, "base64");
  if (channel.type === "telegram") {
    const { sendText, sendVoice } = await import("@/lib/channels/telegram-api");
    const token = (channel.config as TelegramConfig).token;
    // Подпись голосового — до 1024 знаков; длиннее — голосовое, затем текст
    const fits = text.length <= 1000;
    const r = await sendVoice(token, conversation.externalId, ogg, fits ? text : undefined);
    if (!fits) await sendText(token, conversation.externalId, text);
    return { externalId: r ? String(r) : null };
  }
  if (channel.type === "whatsapp") {
    const wa = await import("@/lib/channels/meta/whatsapp");
    const cfg = channel.config as WhatsAppConfig;
    // Одним сообщением: каждое исходящее в WhatsApp платное (с 01.10.2026), текст ответа остаётся в «Диалогах»
    const { logWhatsAppAudio, windowOpen } = await import("@/lib/channels/meta/wa-send");
    if (conversation.id && !(await windowOpen(conversation.id))) return null;
    const id = await wa.sendAudio(cfg.token, cfg.phoneNumberId, conversation.externalId, ogg);
    await logWhatsAppAudio(channel as never, conversation as never);
    return { externalId: id };
  }
  return null;
}
