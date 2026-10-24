import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { firstSeen } from "@/lib/channels/dedupe";
import { channels, messages, type WhatsAppConfig } from "@/db/schema";
import { getMetaSettings } from "@/lib/settings";
import { validSignature, verifyChallenge } from "@/lib/channels/meta/webhook";
import { markRead, messageText, type WaMessage } from "@/lib/channels/meta/whatsapp";
import { markWebhook } from "@/lib/channels/health";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";
import { jsonText } from "@/db/dialect";

/**
 * Вебхук WhatsApp Business (Meta): GET — подтверждение адреса (verify token из «Интеграций»),
 * POST — сообщения клиентов (поле messages). Подпись проверяем секретом приложения WhatsApp
 * (или Instagram, если это одно приложение). Отвечаем Meta сразу, сообщения обрабатываем после.
 */
export const GET = verifyChallenge;

type Change = {
  field: string;
  value: {
    metadata?: { phone_number_id?: string };
    contacts?: { wa_id: string; profile?: { name?: string } }[];
    messages?: WaMessage[];
  };
};

export async function POST(req: Request) {
  const raw = await req.text();
  const meta = await getMetaSettings();
  const app = meta.whatsapp ?? meta.instagram;
  if (!app || !validSignature(raw, req.headers.get("x-hub-signature-256"), app.appSecret)) {
    return new Response("Bad signature", { status: 401 });
  }
  let body: { object?: string; entry?: { changes?: Change[] }[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  after(() => handleWhatsApp(body));
  return Response.json({ ok: true });
}

/** Голосовое — расшифровка на сервере; фото — описание с надписями и превью (как в Telegram). */
async function readMedia(cfg: WhatsAppConfig, m: WaMessage, messageId: string, conversation: { id: string; agentId: string; clientId: string; context: { language?: string } | null }) {
  const { downloadMedia } = await import("@/lib/channels/meta/whatsapp");
  if (m.audio?.id) {
    const { MAX_VOICE_BYTES, transcribeIncoming } = await import("@/lib/voice");
    const f = await downloadMedia(cfg.token, m.audio.id, MAX_VOICE_BYTES);
    if (f) await transcribeIncoming(messageId, f.buf, conversation.context?.language);
    return;
  }
  if (m.image?.id) {
    const f = await downloadMedia(cfg.token, m.image.id, 4 * 1024 * 1024);
    if (!f) return;
    const type = f.mime.startsWith("image/png") ? "image/png" : f.mime.startsWith("image/webp") ? "image/webp" : "image/jpeg";
    const { describePhoto, saveThumb } = await import("@/lib/media");
    const data = f.buf.toString("base64");
    const vision = await describePhoto(data, type, { agentId: conversation.agentId, clientId: conversation.clientId }, m.image.caption);
    const thumb = data.length <= 560_000 ? saveThumb(messageId, data, type) : null;
    const [cur] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
    await db.update(messages).set({ meta: { ...cur?.meta, kind: "photo", ...(vision ? { vision } : {}), ...(thumb ? { thumb } : {}) } }).where(eq(messages.id, messageId));
  }
}

/** Обработка уведомления Meta (вынесено отдельно — так его можно проверить без запроса). */
export async function handleWhatsApp(body: { entry?: { changes?: Change[] }[] }) {
  {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const phoneId = change.value.metadata?.phone_number_id;
        if (!phoneId) continue;
        const [channel] = await db
          .select()
          .from(channels)
          .where(and(eq(channels.type, "whatsapp"), eq(channels.enabled, true), sql`${jsonText(channels.config, "phoneNumberId")} = ${phoneId}`));
        if (!channel) continue;
        await markWebhook(channel.id).catch(() => {});
        const cfg = channel.config as WhatsAppConfig;
        for (const m of change.value.messages ?? []) {
          try {
            const text = messageText(m).trim();
            if (!text) continue;
            // Meta может прислать одно сообщение дважды — второй раз не записываем
            if (!firstSeen(`wa:${m.id}`)) continue;
            const [seen] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, `wa:${m.id}`)).limit(1);
            if (seen) continue;
            const name = change.value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? "";
            const { conversation } = await upsertConversation(channel, m.from, { name, handle: `+${m.from}` });
            if (m.referral) {
              const { setSource } = await import("@/lib/channels/meta/inbound");
              await setSource(conversation, { kind: m.referral.source_type === "ad" ? "ad" : "link", title: m.referral.headline, ref: m.referral.source_id, url: m.referral.source_url, at: Date.now() });
            }
            const msg = await addMessage(conversation.id, "user", text.slice(0, 4000), { externalId: `wa:${m.id}` });
            void markRead(cfg.token, cfg.phoneNumberId, m.id);
            await readMedia(cfg, m, msg.id, conversation).catch((e) => console.error("whatsapp media failed", e));
            scheduleReply(conversation.id);
          } catch (e) {
            console.error("whatsapp inbound failed", e);
          }
        }
      }
    }
  }
}
