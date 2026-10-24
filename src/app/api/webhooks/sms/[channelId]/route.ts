import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, messages } from "@/db/schema";
import { validTwilio, type SmsConfig } from "@/lib/channels/sms";
import { markWebhook } from "@/lib/channels/health";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";
import { publicUrl } from "@/lib/settings";

/**
 * Входящие SMS от Twilio (форма From, To, Body, MessageSid). Подпись X-Twilio-Signature считается по публичному
 * адресу этого вебхука. Ответ Twilio — пустой TwiML: агент отвечает отдельным SMS, когда допишет.
 */
const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!channel || channel.type !== "sms") return new Response("Not found", { status: 404 });
  const cfg = channel.config as SmsConfig;
  const form = Object.fromEntries(new URLSearchParams(await req.text()));
  const url = `${publicUrl() ?? ""}/api/webhooks/sms/${channelId}`;
  if (!validTwilio(cfg.authToken, url, form, req.headers.get("x-twilio-signature"))) return new Response("Bad signature", { status: 401 });
  if (!channel.enabled) return new Response(TWIML, { headers: { "content-type": "text/xml" } });
  await markWebhook(channel.id).catch(() => {});
  const from = form.From ?? "";
  const text = (form.Body ?? "").trim();
  const sid = form.MessageSid ?? "";
  if (from && text) {
    const [seen] = sid ? await db.select({ id: messages.id }).from(messages).where(eq(messages.externalId, `sms:${sid}`)).limit(1) : [];
    if (!seen) {
      const { conversation } = await upsertConversation(channel, from, { handle: from });
      await addMessage(conversation.id, "user", text.slice(0, 1600), { externalId: sid ? `sms:${sid}` : undefined });
      scheduleReply(conversation.id);
    }
  }
  return new Response(TWIML, { headers: { "content-type": "text/xml" } });
}
