import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { firstSeen } from "@/lib/channels/dedupe";
import { channels, messages, type Channel } from "@/db/schema";
import { getMetaSettings } from "@/lib/settings";
import { validSignature, verifyChallenge } from "@/lib/channels/meta/webhook";
import { igSource, setSource } from "@/lib/channels/meta/inbound";
import { markWebhook } from "@/lib/channels/health";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";
import { jsonText } from "@/db/dialect";

/**
 * Вебхук Facebook Messenger (object = page): сообщения, нажатия кнопок, переходы из рекламы и ссылок m.me?ref=.
 * Подпись — секретом приложения Meta (того же, что для WhatsApp или Instagram). Отвечаем Meta сразу.
 */
export const GET = verifyChallenge;

type Entry = {
  id: string;
  messaging?: {
    sender: { id: string };
    recipient: { id: string };
    message?: { mid: string; text?: string; is_echo?: boolean; quick_reply?: { payload: string }; attachments?: { type?: string }[] };
    postback?: { title?: string; payload?: string; mid?: string };
    referral?: { ref?: string; source?: string; ad_id?: string; ads_context_data?: { ad_title?: string } };
  }[];
};

export async function POST(req: Request) {
  const raw = await req.text();
  const meta = await getMetaSettings();
  const app = meta.whatsapp ?? meta.instagram;
  if (!app || !validSignature(raw, req.headers.get("x-hub-signature-256"), app.appSecret)) return new Response("Bad signature", { status: 401 });
  let body: { object?: string; entry?: Entry[] };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  after(() => handleMessenger(body));
  return new Response("OK");
}

export async function handleMessenger(body: { object?: string; entry?: Entry[] }) {
  if (body.object !== "page") return;
  for (const entry of body.entry ?? []) {
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.type, "messenger"), eq(channels.enabled, true), sql`${jsonText(channels.config, "pageId")} = ${entry.id}`));
    if (!channel) continue;
    await markWebhook(channel.id).catch(() => {});
    for (const m of entry.messaging ?? []) {
      try {
        await one(channel, m);
      } catch (e) {
        console.error("messenger inbound failed", e);
      }
    }
  }
}

async function one(channel: Channel, m: NonNullable<Entry["messaging"]>[number]) {
  if (m.message?.is_echo || m.sender.id === (channel.config as { pageId: string }).pageId) return;
  const { text: base, source } = igSource(m.message ? { text: m.message.text, attachments: m.message.attachments } : undefined, m.referral);
  const text = m.postback?.title ?? base;
  const mid = m.message?.mid ?? m.postback?.mid ?? "";
  const { conversation } = await upsertConversation(channel, m.sender.id, {});
  if (source) await setSource(conversation, source);
  if (!text) return;
  if (mid) {
    if (!firstSeen(`fb:${mid}`)) return;
    const [seen] = await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, `fb:${mid}`)).limit(1);
    if (seen) return;
  }
  await addMessage(conversation.id, "user", text.slice(0, 4000), { externalId: mid ? `fb:${mid}` : undefined });
  scheduleReply(conversation.id);
}
