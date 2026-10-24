/** Instagram и источники клиентов: кодовое слово в комментарии → личное сообщение автору (private reply) и короткий
 *  ответ под комментарием, разговор в директе с источником; без слова и с выключенными комментариями — тишина;
 *  ответ на историю и упоминание — пометка в тексте; реклама Instagram и WhatsApp (Click-to-WhatsApp), метка
 *  ссылки t.me/бот?start=… — источник разговора, агент видит его в инструкции. Meta и Telegram — заглушки.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-ig-growth.ts */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { path: string; body: string }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push({ path: url, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (url.includes("/me/messages")) return res.end(JSON.stringify({ message_id: "mid.dm1", recipient_id: "igsid-42" }));
      if (url.includes("/replies")) return res.end(JSON.stringify({ id: "reply-1" }));
      if (url.startsWith("/bot")) return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      res.end(JSON.stringify({ messages: [{ id: "wamid.x" }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(4079, r));
  process.env.INSTAGRAM_GRAPH_URL = "http://127.0.0.1:4079";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4079";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "IG Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "ig-agent", status: "paused" }).returning();
  const [ig] = await db
    .insert(channels)
    .values({
      agentId: a.id,
      clientId: c.id,
      type: "instagram",
      name: "@shop",
      config: { igUserId: "999", username: "shop", token: "t", tokenExpiresAt: 0, dm: true, comments: false, approval: true, triggers: [{ keyword: "Прайс", dm: "Держите прайс: https://shop.ua/price", reply: "Отправили в директ 📩" }] },
    })
    .returning();

  const inbound = await import("@/lib/channels/meta/inbound");
  await inbound.handleInstagramComment(ig, { id: "cm-1", text: "Хочу ПРАЙС!", fromId: "igsid-42", username: "olga", mediaId: "post-1", postUrl: "https://instagram.com/p/1" });
  await inbound.handleInstagramComment(ig, { id: "cm-1", text: "Хочу ПРАЙС!", fromId: "igsid-42", username: "olga", mediaId: "post-1" });
  await inbound.handleInstagramComment(ig, { id: "cm-2", text: "Красиво 😍", fromId: "igsid-43", username: "ivan", mediaId: "post-1" });
  const priv = calls.filter((x) => x.path.includes("/me/messages"));
  const pub = calls.filter((x) => x.path.includes("/cm-1/replies"));
  const [dm] = await db.select().from(conversations).where(eq(conversations.externalId, "dm:igsid-42"));
  const dmMsgs = dm ? await db.select().from(messages).where(eq(messages.conversationId, dm.id)).orderBy(asc(messages.createdAt)) : [];
  const commentConvs = await db.select().from(conversations).where(eq(conversations.channelId, ig.id));

  // История и реклама в директе
  const story = inbound.igSource({ text: "Сколько стоит?", reply_to: { story: { url: "https://cdn/story1" } } });
  const mention = inbound.igSource({ attachments: [{ type: "story_mention", payload: { url: "https://cdn/s2" } }] });
  const ad = inbound.igSource({ text: "Здравствуйте" }, { source: "ADS", ad_id: "ad-7", ads_context_data: { ad_title: "Скидка на диваны" } });
  await inbound.handleInstagramDm(ig, { senderId: "igsid-50", mid: "mid.50", text: ad.text, source: ad.source });
  const [adConv] = await db.select().from(conversations).where(eq(conversations.externalId, "dm:igsid-50"));

  // WhatsApp: реклама Click-to-WhatsApp
  const [wa] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "whatsapp", name: "wa", config: { token: "t", phoneNumberId: "pn-ig-test", displayPhone: "+380" } as never }).returning();
  const { handleWhatsApp } = await import("@/app/api/webhooks/whatsapp/route");
  process.env.WHATSAPP_GRAPH_URL = "http://127.0.0.1:4079";
  await handleWhatsApp({
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn-ig-test" }, contacts: [{ wa_id: "380501", profile: { name: "Оля" } }], messages: [{ id: "w1", from: "380501", type: "text", text: { body: "Хочу диван" }, referral: { source_type: "ad", source_id: "ad-9", headline: "Диваны -20%", source_url: "https://fb.me/ad9" } }] } }] }],
  });
  const [waConv] = await db.select().from(conversations).where(eq(conversations.channelId, wa.id));

  // Telegram: ссылка с меткой
  const [tg] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "@b", config: { token: "1:x", username: "b", botName: "b" } }).returning();
  const { handleUpdate } = await import("@/lib/channels/telegram-poller");
  await handleUpdate(tg.id, { update_id: 1, message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555, first_name: "Петя" }, text: "/start qr_vitrina", date: 0 } } as never);
  const [tgConv] = await db.select().from(conversations).where(eq(conversations.channelId, tg.id));
  const { sourceNote } = await import("@/lib/conversations");

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "кодовое слово: личное сообщение автору комментария (одно, по comment_id)": priv.length === 1 && JSON.parse(priv[0].body).recipient.comment_id === "cm-1" && JSON.parse(priv[0].body).message.text.startsWith("Держите прайс"),
    "под комментарием — короткий ответ": pub.length === 1 && pub[0].body.includes(encodeURIComponent("Отправили").slice(0, 6)),
    "разговор в директе: источник «комментарий», наше сообщение в истории": dm?.context?.source?.kind === "comment" && dm.context.source.title === "Прайс" && dmMsgs.some((m) => m.role === "assistant" && m.text.startsWith("Держите прайс")),
    "без слова и с выключенными комментариями — ничего": !commentConvs.some((x) => x.externalId.startsWith("c:")),
    "ответ на историю и упоминание — пометка": story.text.startsWith("[Ответ на вашу историю https://cdn/story1] Сколько стоит?") && story.source?.kind === "story" && mention.text.startsWith("[Клиент упомянул вас"),
    "реклама Instagram — источник с названием": adConv?.context?.source?.kind === "ad" && adConv.context.source.title === "Скидка на диваны",
    "реклама WhatsApp — источник": waConv?.context?.source?.kind === "ad" && waConv.context.source.ref === "ad-9",
    "метка ссылки Telegram — источник": tgConv?.context?.source?.kind === "link" && tgConv.context.source.ref === "qr_vitrina",
    "агент видит источник": Boolean(sourceNote(adConv?.context?.source)?.includes("«Скидка на диваны»")),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
