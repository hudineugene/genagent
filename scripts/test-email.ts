/**
 * Проверка почтового канала без настоящего ящика: письма подаются прямо в обработчик,
 * ответ уходит на локальный SMTP. Только на копии базы!
 *   DB_PATH=<копия> SMTP_PORT=2525 npx tsx --env-file=.env --conditions=react-server scripts/test-email.ts <agentId>
 */
import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, type EmailConfig } from "@/db/schema";
import { handleIncoming, isAutomated, stripQuoted } from "@/lib/channels/email";
import { deliver, listMessages } from "@/lib/conversations";

async function main() {
const agentId = process.argv[2];
if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");

const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
if (!agent) throw new Error("agent not found");
await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));

const config: EmailConfig = {
  address: "studio@test.local",
  password: "x",
  imapHost: "127.0.0.1",
  imapPort: 1,
  smtpHost: "127.0.0.1",
  smtpPort: Number(process.env.SMTP_PORT ?? 2525),
  fromName: "Studio YABOT",
  approval: true,
  lastUid: 0,
  uidValidity: "1",
};
const [ch] = await db
  .insert(channels)
  .values({ agentId, clientId: agent.clientId, type: "email", name: config.address, config })
  .returning();

const mail = (headers: string, body: string) => simpleParser(Buffer.from(`${headers}\r\n\r\n${body}`));

// 1. Рассылка — пропускаем
const promo = await mail(
  "From: Shop <news@shop.example>\r\nTo: studio@test.local\r\nSubject: Sale!\r\nList-Unsubscribe: <mailto:u@shop.example>\r\nMessage-ID: <promo1@shop.example>",
  "50% off",
);
console.log("newsletter automated:", isAutomated(promo, "news@shop.example"));
await handleIncoming(ch, config, promo);

// 2. Письмо человека с цитатой ниже
const body = [
  "Добрий день!",
  "Хочемо стікерпак для нашої команди — 10 анімованих стікерів з маскотом-лисом. Скільки це коштуватиме і скільки часу займе?",
  "",
  "Ірина, Fox Coffee",
  "",
  "On Mon, 12 Oct 2026 at 10:00, Studio YABOT <studio@test.local> wrote:",
  "> старий лист",
].join("\r\n");
console.log("stripped:", JSON.stringify(stripQuoted(body)));
const real = await mail(
  "From: =?UTF-8?B?0IbRgNC40L3QsA==?= <iryna@foxcoffee.example>\r\nTo: studio@test.local\r\nSubject: =?UTF-8?B?0KHRgtGW0LrQtdGA0Lgg0LTQu9GPINC60L7QvNCw0L3QtNC4?=\r\nMessage-ID: <q1@foxcoffee.example>\r\nContent-Type: text/plain; charset=utf-8",
  body,
);
await handleIncoming(ch, config, real);
await handleIncoming(ch, config, real); // повтор — должен отсечься

// Ждём, пока агент подготовит черновик
const [conv] = await db
  .select()
  .from(conversations)
  .where(and(eq(conversations.channelId, ch.id), eq(conversations.externalId, "iryna@foxcoffee.example")));
let draft;
for (let i = 0; i < 40 && !draft; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  draft = (await listMessages(conv.id)).find((m) => m.status === "draft");
}
const all = await listMessages(conv.id);
console.log("\nconversations from newsletter:", (await db.select().from(conversations).where(eq(conversations.externalId, "news@shop.example"))).length);
console.log("messages:", all.map((m) => `${m.role}/${m.status}: ${m.text.slice(0, 80).replace(/\n/g, " ")}`));
const [fresh] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
console.log("contact:", fresh.contactName, fresh.contactHandle, "context:", JSON.stringify(fresh.context));
if (!draft) throw new Error("no draft");
console.log("\n--- DRAFT ---\n" + draft.text);

// «Одобрить»: отправка по SMTP в ту же ветку
const sentId = await deliver(ch, fresh, draft.text);
console.log("\nsent message-id:", sentId);

await db.delete(channels).where(eq(channels.id, ch.id));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
