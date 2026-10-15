/**
 * Проверка уведомлений студии без настоящего Telegram: поддельный Bot API на 127.0.0.1:4020,
 * письмо → черновик → уведомление с кнопками → «нажатие» → письмо ушло (локальный SMTP), передача с выжимкой, сбой.
 * Только на копии базы:
 *   DB_PATH=<копия> SMTP_PORT=2525 TELEGRAM_API_URL=http://127.0.0.1:4020 npx tsx --env-file=.env scripts/test-notify.ts <agentId>
 */
import http from "node:http";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, type EmailConfig } from "@/db/schema";
import { handleIncoming } from "@/lib/channels/email";
import { listMessages } from "@/lib/conversations";
import { notifyHandoff, notifyProblem, saveNotifySettings, getNotifySettings } from "@/lib/notify/telegram";

type Sent = { method: string; body: Record<string, unknown> };
const sent: Sent[] = [];
const queue: unknown[] = [];
let updateId = 1;

function fakeTelegram() {
  return http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", async () => {
        const method = String(req.url).split("/").pop() ?? "";
        const body = raw ? JSON.parse(raw) : {};
        const reply = (result: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        };
        if (method === "getUpdates") {
          for (let i = 0; i < 20 && !queue.length; i++) await new Promise((r) => setTimeout(r, 100));
          return reply(queue.splice(0));
        }
        sent.push({ method, body });
        if (method === "getMe") return reply({ id: 1, username: "genagent_alerts_bot", first_name: "Alerts" });
        return reply(method === "sendMessage" ? { message_id: 100 + sent.length } : true);
      });
    })
    .listen(4020, "127.0.0.1");
}

const wait = async (check: () => boolean | Promise<boolean>, ms = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

async function main() {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const agentId = process.argv[2];
  const server = fakeTelegram();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));

  // 1. Подписка по ссылке
  await saveNotifySettings({ token: "777:AAAAAAAAAAAAAAAAAAAAAAAAAAAA", botUsername: "genagent_alerts_bot", linkCode: "secret-code", adminUrl: "https://studio.example", subscribers: [] });
  queue.push({ update_id: updateId++, message: { chat: { id: 5001, type: "private" }, from: { first_name: "Женя" }, text: "/start wrong" } });
  queue.push({ update_id: updateId++, message: { chat: { id: 5001, type: "private" }, from: { first_name: "Женя" }, text: "/start secret-code" } });
  await wait(async () => ((await getNotifySettings())?.subscribers.length ?? 0) > 0, 10_000);
  console.log("подписчики:", (await getNotifySettings())?.subscribers.map((s) => s.name));
  console.log("ответы бота:", sent.filter((s) => s.method === "sendMessage").map((s) => String(s.body.text).slice(0, 60)));

  // 2. Письмо → черновик → уведомление с кнопками
  const config: EmailConfig = { address: "studio@test.local", password: "x", imapHost: "127.0.0.1", imapPort: 1, smtpHost: "127.0.0.1", smtpPort: Number(process.env.SMTP_PORT ?? 2525), fromName: "Studio YABOT", approval: true, lastUid: 0, uidValidity: "1" };
  const [ch] = await db.insert(channels).values({ agentId, clientId: agent.clientId, type: "email", name: config.address, config }).returning();
  const mail = await simpleParser(Buffer.from("From: Olga <olga@example.com>\r\nTo: studio@test.local\r\nSubject: Stickers\r\nMessage-ID: <n1@example.com>\r\n\r\nСкільки коштують 10 статичних стікерів?"));
  const before = sent.length;
  await handleIncoming(ch, config, mail);
  await wait(() => sent.slice(before).some((s) => s.method === "sendMessage" && String(s.body.text).includes("Черновик")));
  const draftNote = sent.slice(before).find((s) => s.method === "sendMessage" && String(s.body.text).includes("Черновик"));
  console.log("\nуведомление о черновике:\n" + String(draftNote?.body.text).slice(0, 500));
  const markup = draftNote?.body.reply_markup as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
  console.log("кнопки:", markup.inline_keyboard.flat().map((b) => b.text + (b.url ? ` → ${b.url}` : "")));

  // 3. «Нажатие» «Опубликовать» чужим чатом — отказ; подписчиком — публикация
  const approve = markup.inline_keyboard[0][0].callback_data!;
  queue.push({ update_id: updateId++, callback_query: { id: "q1", from: { first_name: "Чужой" }, data: approve, message: { chat: { id: 9999 }, message_id: 1, text: "x" } } });
  queue.push({ update_id: updateId++, callback_query: { id: "q2", from: { first_name: "Женя" }, data: approve, message: { chat: { id: 5001 }, message_id: 101, text: "Черновик…" } } });
  const draftId = approve.split(":")[1];
  await wait(async () => (await db.select({ s: messages.status }).from(messages).where(eq(messages.id, draftId)))[0]?.s === "sent", 15_000);
  console.log("\nстатус черновика после кнопки:", (await db.select({ s: messages.status, e: messages.externalId }).from(messages).where(eq(messages.id, draftId)))[0]);
  console.log("ответы на нажатия:", sent.filter((s) => s.method === "answerCallbackQuery").map((s) => s.body.text));
  console.log("правка сообщения:", sent.filter((s) => s.method === "editMessageText").map((s) => String(s.body.text).split("\n").pop()));

  // 4. Передача с выжимкой и сбой
  const [conv] = await db.select().from(conversations).where(eq(conversations.channelId, ch.id));
  await notifyHandoff(conv.id, "Ольга хочет 10 статичних стікерів, питала ціну. Чекає дзвінка менеджера.");
  await notifyProblem("test:budget", "budget_exceeded", { conversationId: conv.id });
  await notifyProblem("test:budget", "budget_exceeded", { conversationId: conv.id }); // повтор в тот же день — не уходит
  const last = sent.filter((s) => s.method === "sendMessage").slice(-2).map((s) => String(s.body.text));
  console.log("\nпередача:\n" + last[0] + "\n\nсбой:\n" + last[1]);
  console.log("повтор сбоя отправлен?", sent.filter((s) => s.method === "sendMessage" && String(s.body.text).includes("Сбой")).length > 1);
  console.log("сообщений в переписке:", (await listMessages(conv.id)).length);

  await db.delete(channels).where(eq(channels.id, ch.id));
  await saveNotifySettings(null);
  server.close();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
