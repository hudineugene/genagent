import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { channels, messages, type WhatsAppConfig } from "@/db/schema";
import { getMetaSettings } from "@/lib/settings";
import { validSignature, verifyChallenge } from "@/lib/channels/meta/webhook";
import { markRead, messageText, type WaMessage } from "@/lib/channels/meta/whatsapp";
import { markWebhook } from "@/lib/channels/health";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";

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
          .where(and(eq(channels.type, "whatsapp"), eq(channels.enabled, true), sql`json_extract(${channels.config}, '$.phoneNumberId') = ${phoneId}`));
        if (!channel) continue;
        await markWebhook(channel.id).catch(() => {});
        const cfg = channel.config as WhatsAppConfig;
        for (const m of change.value.messages ?? []) {
          try {
            const text = messageText(m).trim();
            if (!text) continue;
            // Meta может прислать одно сообщение дважды — второй раз не записываем
            const [seen] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, `wa:${m.id}`)).limit(1);
            if (seen) continue;
            const name = change.value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? "";
            const { conversation } = await upsertConversation(channel, m.from, { name, handle: `+${m.from}` });
            await addMessage(conversation.id, "user", text.slice(0, 4000), { externalId: `wa:${m.id}` });
            void markRead(cfg.token, cfg.phoneNumberId, m.id);
            scheduleReply(conversation.id);
          } catch (e) {
            console.error("whatsapp inbound failed", e);
          }
        }
      }
    }
  }
}
