/**
 * Ответ клиенту из бота уведомлений на копии базы (Telegram — заглушка, без ИИ):
 * DB_PATH=<копия caltest> npx tsx scripts/test-notify-reply.ts
 */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { channels, conversations, messages, settings } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextId = 100;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: String(req.url).split("/").pop() ?? "", body: body ? JSON.parse(body) : {} });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: ++nextId } }));
    });
  });
  await new Promise<void>((r) => server.listen(4013, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4013";

  const [oldNotify] = await db.select().from(settings).where(eq(settings.key, "notify"));
  await db
    .insert(settings)
    .values({ key: "notify", value: { token: "123:TEST", botUsername: "test_notify_bot", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "QA", since: 1 }] }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: { token: "123:TEST", botUsername: "test_notify_bot", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "QA", since: 1 }] } } });
  const n = await import("@/lib/notify/telegram");

  const [widget] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: widget.clientId, agentId: widget.agentId, channelId: widget.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "Анна", mode: "human" } as never)
    .returning();
  await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Позовіть людину", createdAt: new Date() } as never);

  await n.notifyHandoff(conv.id, "Хочет поговорить с человеком");
  const handoff = calls.find((c) => c.method === "sendMessage");
  const kb = JSON.stringify(handoff?.body.reply_markup ?? {});

  calls.length = 0;
  await n.handleNotifyUpdate({ update_id: 1, callback_query: { id: "cb1", from: { first_name: "QA" }, data: `rp:${conv.id}`, message: { chat: { id: 777 }, message_id: 5 } } } as never);
  const prompt = calls.find((c) => c.method === "sendMessage");
  calls.length = 0;
  await n.handleNotifyUpdate({ update_id: 2, message: { message_id: 6, chat: { id: 777, type: "private" }, text: "Добрий день! Зараз допоможу." } } as never);
  const sentOk = calls.find((c) => c.method === "sendMessage" && String(c.body.text).startsWith("✅"));
  const op = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));

  calls.length = 0;
  await n.handleNotifyUpdate({ update_id: 3, message: { message_id: 7, chat: { id: 999, type: "private" }, text: "чужой" } } as never);
  const stranger = calls.length === 0;

  await n.handleNotifyUpdate({ update_id: 4, callback_query: { id: "cb2", from: { first_name: "QA" }, data: `rt:${conv.id}`, message: { chat: { id: 777 }, message_id: 8 } } } as never);
  const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));

  const checks: Record<string, boolean> = {
    "в уведомлении кнопки «Ответить» и «Вернуть агенту»": kb.includes(`rp:${conv.id}`) && kb.includes(`rt:${conv.id}`),
    "по «Ответить» — подсказка с force_reply": JSON.stringify(prompt?.body.reply_markup ?? {}).includes("force_reply"),
    "текст сотрудника сохранён как ответ оператора": op.some((m) => m.role === "operator" && m.text === "Добрий день! Зараз допоможу."),
    "подтверждение «Отправлено»": Boolean(sentOk),
    "чужой чат игнорируется": stranger,
    "«Вернуть агенту» — режим агента": after.mode === "ai",
  };
  console.log(checks);

  await db.delete(conversations).where(eq(conversations.id, conv.id));
  if (oldNotify) await db.update(settings).set({ value: oldNotify.value }).where(eq(settings.key, "notify"));
  else await db.delete(settings).where(eq(settings.key, "notify"));
  server.close();
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
