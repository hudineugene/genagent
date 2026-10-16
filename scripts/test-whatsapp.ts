/** WhatsApp Business: вебхук (подтверждение, подпись, входящие, без дублей), «прочитано», ответ агента (Meta и модель — заглушки).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-whatsapp.ts */
import http from "node:http";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, settings } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const graph: { url: string; body: Record<string, unknown> }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Модель (Anthropic) — потоковый ответ
      if (req.url?.startsWith("/v1/messages")) {
        const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
            ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "¡Hola! **Villa Sol** cuesta 550 000 €." } }) +
            ev("content_block_stop", { index: 0 }) +
            ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
            ev("message_stop", {}),
        );
        return;
      }
      // Graph API WhatsApp
      graph.push({ url: req.url ?? "", body: body ? JSON.parse(body) : {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.includes("/messages") ? { messages: [{ id: "wamid.OUT1" }] } : { id: "1234567", display_phone_number: "+34 600 000 000", verified_name: "Kornilenko" }));
    });
  });
  await new Promise<void>((r) => stub.listen(4025, r));
  process.env.WHATSAPP_GRAPH_URL = "http://127.0.0.1:4025";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4025";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [meta] = await db.select().from(settings).where(eq(settings.key, "meta"));
  const secret = "0123456789abcdef0123456789abcdef";
  const verifyToken = "verify-test";
  await db
    .insert(settings)
    .values({ key: "meta", value: { ...((meta?.value as object) ?? {}), verifyToken, whatsapp: { appId: "123456789", appSecret: secret } }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: { ...((meta?.value as object) ?? {}), verifyToken, whatsapp: { appId: "123456789", appSecret: secret } } } });
  // Остатки прошлых запусков
  for (const old of await db.select().from(channels).where(eq(channels.type, "whatsapp"))) {
    if ((old.config as { phoneNumberId?: string }).phoneNumberId !== "1234567") continue;
    for (const c of await db.select().from(conversations).where(eq(conversations.channelId, old.id))) {
      await db.delete(messages).where(eq(messages.conversationId, c.id));
      await db.delete(conversations).where(eq(conversations.id, c.id));
    }
    await db.delete(channels).where(eq(channels.id, old.id));
  }
  const [agent] = await db.select().from(agents).limit(1);
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
  const [ch] = await db
    .insert(channels)
    .values({ agentId: agent.id, clientId: agent.clientId, type: "whatsapp", name: "+34 600 000 000", config: { phoneNumberId: "1234567", displayPhone: "+34 600 000 000", token: "EAAtesttoken1234567890" } })
    .returning();

  const route = await import("@/app/api/webhooks/whatsapp/route");
  const verify = await route.GET(new Request(`http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=42`));
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1234567" }, contacts: [{ wa_id: "34611222333", profile: { name: "Lucía" } }], messages: [{ id: "wamid.IN1", from: "34611222333", type: "text", text: { body: "¿Cuánto cuesta Villa Sol?" } }] } }] }],
  });
  const sign = (raw: string) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const bad = await route.POST(new Request("http://x/api/webhooks/whatsapp", { method: "POST", body: payload, headers: { "x-hub-signature-256": "sha256=00" } }));
  // Верная подпись: POST сразу отвечает и откладывает обработку (after) — вне запроса Next проверяем её напрямую
  let ok: Response | null = null;
  try {
    ok = await route.POST(new Request("http://x/api/webhooks/whatsapp", { method: "POST", body: payload, headers: { "x-hub-signature-256": sign(payload) } }));
  } catch (e) {
    if (!String(e).includes("outside a request scope")) throw e;
    ok = new Response(null, { status: 200 });
  }
  await route.handleWhatsApp(JSON.parse(payload));
  // Повторная доставка того же сообщения
  await route.handleWhatsApp(JSON.parse(payload));

  let conv;
  let reply;
  for (let i = 0; i < 60 && !reply; i++) {
    await new Promise((r) => setTimeout(r, 250));
    [conv] = await db.select().from(conversations).where(eq(conversations.channelId, ch.id));
    if (conv) [reply] = (await db.select().from(messages).where(eq(messages.conversationId, conv.id))).filter((m) => m.role === "assistant");
  }
  const userMsgs = conv ? (await db.select().from(messages).where(eq(messages.conversationId, conv.id))).filter((m) => m.role === "user") : [];
  const sent = graph.find((g) => (g.body as { type?: string }).type === "text");
  const read = graph.find((g) => (g.body as { status?: string }).status === "read");

  if (conv) {
    await db.delete(messages).where(eq(messages.conversationId, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
  }
  await db.delete(channels).where(eq(channels.id, ch.id));
  if (meta) await db.update(settings).set({ value: meta.value }).where(eq(settings.key, "meta"));
  else await db.delete(settings).where(eq(settings.key, "meta"));
  stub.close();

  const checks: Record<string, boolean> = {
    "подтверждение адреса вебхука": verify.status === 200 && (await verify.text()) === "42",
    "неверная подпись — отказ": bad.status === 401,
    "верная подпись — принято": ok?.status === 200,
    "разговор: имя и номер клиента": conv?.contactName === "Lucía" && conv?.contactHandle === "+34611222333" && conv?.externalId === "34611222333",
    "одно сообщение, без дубля": userMsgs.length === 1 && userMsgs[0].text === "¿Cuánto cuesta Villa Sol?",
    "отметка «прочитано»": Boolean(read) && (read!.body as { message_id?: string }).message_id === "wamid.IN1",
    "ответ агента ушёл в WhatsApp без разметки": Boolean(sent) && (sent!.body as { to?: string }).to === "34611222333" && JSON.stringify(sent!.body).includes("Villa Sol cuesta") && !JSON.stringify(sent!.body).includes("**"),
    "ответ сохранён с id WhatsApp": reply?.externalId === "wamid.OUT1",
  };
  console.log(checks, conv && { n: conv.contactName, h: conv.contactHandle, e: conv.externalId }, userMsgs.map((m) => m.text), reply && { ext: reply.externalId });
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
