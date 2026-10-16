/** Серия стикеров клиента — одно уведомление менеджеру, текст между ними — отдельное (Telegram — заглушка, без ИИ).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-stickers.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, settings } from "@/db/schema";
import { isSticker } from "@/lib/sticker";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (String(req.url).endsWith("/sendMessage")) sent.push(String(JSON.parse(body).text));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(4027, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4027";

  const [oldNotify] = await db.select().from(settings).where(eq(settings.key, "notify"));
  const value = { token: "123:TEST", botUsername: "test_notify_bot", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "QA", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value } });
  const n = await import("@/lib/notify/telegram");

  const [widget] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: widget.clientId, agentId: widget.agentId, channelId: widget.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "Анатолий", mode: "human" } as never)
    .returning();

  await n.notifyClientMessage(conv.id, "Стикер", "s1");
  await n.notifyClientMessage(conv.id, "[Стикер]", "s2");
  await n.notifyClientMessage(conv.id, "Стикер", "s3");
  const afterStickers = sent.length;
  await n.notifyClientMessage(conv.id, "Ещё вопрос про сайт", "t1");
  await n.notifyClientMessage(conv.id, "Стикер", "s4");
  const total = sent.length;

  await db.delete(messages).where(eq(messages.conversationId, conv.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  if (oldNotify) await db.update(settings).set({ value: oldNotify.value }).where(eq(settings.key, "notify"));
  else await db.delete(settings).where(eq(settings.key, "notify"));
  server.close();

  const checks: Record<string, boolean> = {
    "распознаём стикер (с отметкой, подписью, в скобках)": isSticker("👍", "sticker") && isSticker("Стикер") && isSticker("[стикер]") && isSticker("Стікер") && !isSticker("Стикеры для бота?"),
    "три стикера подряд — одно уведомление": afterStickers === 1,
    "текст после стикеров — уведомление, новый стикер после текста — тоже": total === 3,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
