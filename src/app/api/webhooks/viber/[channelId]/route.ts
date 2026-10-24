import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, type Channel, type ViberConfig } from "@/db/schema";
import { messageText, validSignature, type ViberEvent } from "@/lib/channels/viber";
import { markWebhook } from "@/lib/channels/health";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";

/**
 * Вебхук бота Viber: подпись X-Viber-Content-Signature (HMAC-SHA256 токеном бота). Сообщение — в разговор и ответ
 * агента; открытие чата — приветствие (Viber показывает его до первого сообщения клиента).
 */
export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const raw = await req.text();
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!channel || channel.type !== "viber") return new Response("Not found", { status: 404 });
  const cfg = channel.config as ViberConfig;
  if (!validSignature(raw, req.headers.get("x-viber-content-signature"), cfg.token)) return new Response("Bad signature", { status: 401 });
  let ev: ViberEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  if (!channel.enabled) return Response.json({ ok: true });
  await markWebhook(channel.id).catch(() => {});
  // Приветствие: Viber берёт его прямо из ответа на conversation_started
  if (ev.event === "conversation_started" && cfg.welcome?.trim()) {
    return Response.json({ sender: { name: cfg.botName.slice(0, 28), ...(cfg.avatar ? { avatar: cfg.avatar } : {}) }, type: "text", text: cfg.welcome.trim() });
  }
  if (ev.event === "message") after(() => handleViber(channel, ev));
  return Response.json({ ok: true });
}

/** Сообщение клиента (вынесено отдельно — так его можно проверить без запроса). */
export async function handleViber(channel: Channel, ev: ViberEvent) {
  try {
    const from = ev.sender;
    if (!from?.id || !ev.message) return;
    const text = messageText(ev.message).trim();
    if (!text) return;
    const externalId = `vb:${ev.message_token ?? ""}`;
    // Viber повторяет уведомление, если мы не ответили вовремя — второй раз не записываем
    if (ev.message_token) {
      const [seen] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, externalId)).limit(1);
      if (seen) return;
    }
    const { conversation, created } = await upsertConversation(channel, from.id, { name: from.name ?? "" });
    if (created && from.language) {
      await db.update(conversations).set({ context: { ...conversation.context, language: from.language.slice(0, 2) } }).where(eq(conversations.id, conversation.id));
    }
    const msg = await addMessage(conversation.id, "user", text.slice(0, 4000), { externalId: ev.message_token ? externalId : undefined });
    if (ev.message.type === "picture" && ev.message.media && msg) await readPhoto(ev.message.media, msg.id, conversation).catch((e) => console.error("viber photo failed", e));
    scheduleReply(conversation.id);
  } catch (e) {
    console.error("viber inbound failed", e);
  }
}

/** Фото: описание с надписями и превью (как в Telegram и WhatsApp). */
async function readPhoto(url: string, messageId: string, conversation: { agentId: string; clientId: string }) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) return;
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const type = mime.startsWith("image/png") ? "image/png" : mime.startsWith("image/webp") ? "image/webp" : "image/jpeg";
  const { describePhoto, saveThumb } = await import("@/lib/media");
  const data = buf.toString("base64");
  const vision = await describePhoto(data, type, { agentId: conversation.agentId, clientId: conversation.clientId });
  const thumb = data.length <= 560_000 ? saveThumb(messageId, data, type) : null;
  const [cur] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
  await db.update(messages).set({ meta: { ...cur?.meta, kind: "photo", ...(vision ? { vision } : {}), ...(thumb ? { thumb } : {}) } }).where(eq(messages.id, messageId));
}
