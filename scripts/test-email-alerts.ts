/** Тревога «почта: нет связи»: разовые обрывы — только в журнал, тревога — после 5 неудач подряд, о восстановлении —
 *  отдельное сообщение. Почтовый сервер недоступен (127.0.0.1:1), Telegram — локальный макет.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-email-alerts.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, type EmailConfig } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/sendMessage")) sent.push(JSON.parse(body).text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: req.url?.endsWith("/getUpdates") ? [] : { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(4039, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4039";

  const notify = await getSetting("notify");
  await setSetting("notify", { token: "stub", subscribers: [{ chatId: "1" }] });
  // Остальные почтовые каналы копии не опрашиваем (там могут быть настоящие ящики)
  const others = await db.select({ id: channels.id, enabled: channels.enabled }).from(channels).where(eq(channels.type, "email"));
  await db.update(channels).set({ enabled: false }).where(eq(channels.type, "email"));
  const [agent] = await db.select().from(agents).limit(1);
  const config: EmailConfig = { address: "alert@test.local", password: "x", imapHost: "127.0.0.1", imapPort: 1, smtpHost: "127.0.0.1", smtpPort: 1, fromName: "T", approval: true };
  const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "email", name: "alert@test.local", config }).returning();

  const { pollNow } = await import("@/lib/channels/email");
  const { notifyRecovered } = await import("@/lib/notify/telegram");
  const errorOf = async () => (await db.select({ e: channels.error }).from(channels).where(eq(channels.id, ch.id)))[0].e;
  const poll = async () => {
    pollNow(ch.id);
    await new Promise((r) => setTimeout(r, 1500));
  };
  for (let i = 0; i < 4; i++) await poll();
  const after4 = { sent: sent.length, error: await errorOf() };
  await poll();
  await new Promise((r) => setTimeout(r, 500));
  const after5 = { sent: [...sent], error: await errorOf() };
  await poll();
  const after6 = sent.length;
  await notifyRecovered(`channel:${ch.id}:email_unreachable`, ch.id, "почта снова работает");

  await db.delete(channels).where(eq(channels.id, ch.id));
  for (const o of others) await db.update(channels).set({ enabled: o.enabled }).where(eq(channels.id, o.id));
  await setSetting("notify", notify);
  stub.close();

  const result: Record<string, boolean> = {
    "4 неудачи — тревоги нет, ошибка канала не выставлена": after4.sent === 0 && after4.error === null,
    "5-я неудача — одна тревога «нет связи»": after5.sent.length === 1 && after5.sent[0].includes("нет связи с сервером") && after5.error === "email_unreachable",
    "дальше не повторяется": after6 === 1,
    "о восстановлении — «снова работает»": sent.length === 2 && sent[1].includes("почта снова работает") && sent[1].includes("alert@test.local"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
