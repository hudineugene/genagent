/** Messenger и SMS: сообщение страницы → разговор (повтор не дублируется, своё эхо и реклама учтены), ответ — Send API
 *  с кнопками быстрых ответов; SMS: подпись Twilio (чужая — 401), входящее → разговор, ответ — Messages API с номера
 *  клиента; рассылки видят SMS. Meta и Twilio — заглушка.  DB_PATH=<копия caltest> npx tsx scripts/test-messenger-sms.ts */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { path: string; body: string; auth?: string }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ path: req.url ?? "", body, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.includes("/Messages.json") ? { sid: "SM123" } : { message_id: "mid.out", recipient_id: "u1" }));
    });
  });
  await new Promise<void>((r) => stub.listen(4086, r));
  process.env.MESSENGER_GRAPH_URL = "http://127.0.0.1:4086";
  process.env.TWILIO_API_URL = "http://127.0.0.1:4086";
  process.env.PUBLIC_URL = "https://agents.test";

  const [c] = await db.insert(clients).values({ name: "Msgr SMS" }).returning();
  const [a] = await db.insert(agents).values({ clientId: c.id, name: "ms", status: "paused", config: agentConfigSchema.parse({ model: "anthropic:claude-haiku-5-5" }) }).returning();
  const [fb] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "messenger", name: "Shop", config: { pageId: "PAGE1", pageName: "Shop", token: "pt" } }).returning();
  const [sms] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "sms", name: "+15550001111", config: { accountSid: `AC${"a".repeat(32)}`, authToken: "tw-secret-token-123456", from: "+15550001111" } }).returning();

  const { handleMessenger } = await import("@/app/api/webhooks/messenger/route");
  const ev = { object: "page", entry: [{ id: "PAGE1", messaging: [{ sender: { id: "u1" }, recipient: { id: "PAGE1" }, message: { mid: "m1", text: "Есть доставка?" }, referral: { source: "ADS", ad_id: "ad1", ads_context_data: { ad_title: "Диваны" } } }] }] };
  await handleMessenger(ev);
  await handleMessenger(ev);
  await handleMessenger({ object: "page", entry: [{ id: "PAGE1", messaging: [{ sender: { id: "PAGE1" }, recipient: { id: "u1" }, message: { mid: "m2", text: "эхо", is_echo: true } }] }] });
  const [fbConv] = await db.select().from(conversations).where(eq(conversations.channelId, fb.id));
  const fbMsgs = await db.select().from(messages).where(eq(messages.conversationId, fbConv.id));
  const { deliver } = await import("@/lib/conversations");
  await deliver(fb, fbConv, "Да, по Киеву — завтра.", { buttons: ["Оформить", "Цены"] });
  const sent = JSON.parse(calls.find((x) => x.path.includes("/me/messages"))!.body);

  // SMS
  const { POST } = await import("@/app/api/webhooks/sms/[channelId]/route");
  const { twilioSignature } = await import("@/lib/channels/sms");
  const form = { From: "+380671112233", To: "+15550001111", Body: "Когда откроетесь?", MessageSid: "SMin1" };
  const url = `https://agents.test/api/webhooks/sms/${sms.id}`;
  const post = (sig: string) => POST(new Request(url, { method: "POST", body: new URLSearchParams(form).toString(), headers: { "x-twilio-signature": sig, "content-type": "application/x-www-form-urlencoded" } }), { params: Promise.resolve({ channelId: sms.id }) });
  const bad = await post("nope");
  const ok = await post(twilioSignature("tw-secret-token-123456", url, form));
  const twiml = await ok.text();
  const [smsConv] = await db.select().from(conversations).where(eq(conversations.channelId, sms.id));
  const smsMsgs = await db.select().from(messages).where(eq(messages.conversationId, smsConv.id)).orderBy(asc(messages.createdAt));
  const sid = await deliver(sms, smsConv, "Открываемся в 9:00.");
  const tw = calls.find((x) => x.path.includes("/Messages.json"))!;
  const { PUSH_CHANNELS } = await import("@/lib/campaigns/engine");

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const twBody = new URLSearchParams(tw.body);
  const r: Record<string, boolean> = {
    "Messenger: сообщение → разговор один раз, эхо страницы не записано": fbMsgs.filter((m) => m.role === "user").length === 1 && fbMsgs[0].text === "Есть доставка?",
    "Messenger: реклама — источник клиента": fbConv.context?.source?.kind === "ad" && fbConv.context.source.title === "Диваны",
    "Messenger: ответ Send API с кнопками": sent.recipient.id === "u1" && sent.message.text.startsWith("Да, по Киеву") && sent.message.quick_replies.length === 2,
    "SMS: чужая подпись — 401": bad.status === 401,
    "SMS: входящее → разговор, ответ Twilio — пустой TwiML": ok.status === 200 && twiml.includes("<Response></Response>") && smsConv.externalId === "+380671112233" && smsMsgs[0].text === "Когда откроетесь?",
    "SMS: ответ клиенту с номера Twilio": sid === "SM123" && twBody.get("To") === "+380671112233" && twBody.get("From") === "+15550001111" && Boolean(tw.auth?.startsWith("Basic ")),
    "рассылки и напоминания видят SMS": PUSH_CHANNELS.includes("sms"),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
