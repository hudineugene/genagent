/**
 * Форма заявки сайта студии (api/widget/[channelId]/lead) без настоящего Telegram: поддельный Bot API на 127.0.0.1:4026.
 * Чужой сайт — 403, пустое имя — 400, ловушка для ботов — «принято» без уведомления, заявка — во «Входящие» и в Telegram,
 * четвёртая заявка с одного адреса за 10 минут — 429. Только на копии базы:
 *   DB_PATH=<копия caltest> TELEGRAM_API_URL=http://127.0.0.1:4026 npx tsx scripts/test-site-lead.ts
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import { getNotifySettings, saveNotifySettings } from "@/lib/notify/telegram";
import { POST } from "@/app/api/widget/[channelId]/lead/route";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  if (!process.env.TELEGRAM_API_URL?.includes("4026")) throw new Error("Нужен TELEGRAM_API_URL=http://127.0.0.1:4026");
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const tg = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const method = String(req.url).split("/").pop() ?? "";
      if (method !== "getUpdates") sent.push({ method, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 1 } : method === "getUpdates" ? [] : true }));
    });
  });
  await new Promise<void>((r) => tg.listen(4026, r));

  // Нужен включённый виджет; если в копии его нет — превращаем в виджет любой канал (это копия базы)
  let [ch] = await db.select().from(channels).where(and(eq(channels.type, "widget"), eq(channels.enabled, true))).limit(1);
  if (!ch) {
    const [client] = await db.insert(clients).values({ name: "lead-test" }).returning();
    const [agent] = await db.insert(agents).values({ clientId: client.id, name: "lead-test", config: {} as never }).returning();
    [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: client.id, type: "widget", name: "lead-test", config: {} as never }).returning();
  }
  const before = await getNotifySettings();
  await saveNotifySettings({ token: "TEST", botUsername: "t", linkCode: "x", adminUrl: "https://admin.test", subscribers: [{ chatId: "1", name: "Студия", since: 0 }] });

  const call = (body: unknown, origin = "https://yabotua.com", ip = "10.0.0.1") =>
    POST(new Request("https://agents.test/api/widget/x/lead", { method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ channelId: ch.id }) });
  const ok = (cond: unknown, what: string) => { if (!cond) throw new Error("FAIL: " + what); console.log("ok —", what); };
  const visitor = randomUUID();
  const lead = { visitor, lang: "uk", name: "Олена", contact: "@olena_test", need: "Стікерпак для кав’ярні", page: "/services/stickers/" };

  ok((await call(lead, "https://evil.example")).status === 403, "чужой сайт — 403");
  ok((await call({ ...lead, name: "  " })).status === 400, "пустое имя — 400");
  const trap = await call({ ...lead, website: "spam.example" }, undefined, "10.0.0.9");
  ok(trap.status === 200 && !sent.length, "ловушка: «принято», уведомления нет");

  const res = await call(lead);
  ok(res.status === 200 && (await res.json()).ok === true, "заявка принята");
  await new Promise((r) => setTimeout(r, 300));
  const msg = sent.find((s) => s.method === "sendMessage");
  ok(msg && String(msg.body.text).includes("Олена") && String(msg.body.text).includes("@olena_test") && String(msg.body.text).includes("/services/stickers/"), "в Telegram: имя, связь, страница");
  ok(JSON.stringify(msg?.body.reply_markup ?? "").includes("/inbox?c="), "кнопка «Открыть диалог»");
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.channelId, ch.id), eq(conversations.externalId, visitor)));
  ok(conv, "диалог во «Входящих»");
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
  ok(msgs.some((m) => m.text.includes("Стікерпак для кав’ярні")), "текст заявки во «Входящих»");

  await call({ ...lead, visitor: randomUUID() });
  await call({ ...lead, visitor: randomUUID() });
  ok((await call({ ...lead, visitor: randomUUID() })).status === 429, "четвёртая за 10 минут — 429");

  await saveNotifySettings(before ?? null);
  tg.close();
  console.log("Все проверки формы заявки прошли");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
