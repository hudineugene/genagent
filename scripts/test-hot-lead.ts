/** Оповещение «горячий клиент в чате»: один раз, не после передачи менеджеру и не тестовым; ночью — утром
 *  (модель и Telegram — заглушки). DB_PATH=<копия caltest> npx tsx scripts/test-hot-lead.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, settings } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (String(req.url).includes("/bot")) {
        if (String(req.url).endsWith("/sendMessage")) sent.push(String(JSON.parse(body).text));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        return;
      }
      const text = JSON.stringify({ temperature: "hot", reason: "просит показать виллу в субботу", fields: [{ label: "Что ищет", value: "вилла с бассейном" }] });
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4036, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4036";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4036";

  const keep = await db.select().from(settings).where(inArray(settings.key, ["notify", "waitReminders"]));
  const notify = { token: "123:TEST", botUsername: "t_bot", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "QA", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value: notify, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: notify } });
  const hours = async (open: boolean) => {
    const v = { enabled: true, firstMin: 20, secondMin: 60, fromHour: open ? 0 : 5, toHour: open ? 24 : 5 };
    await db.insert(settings).values({ key: "waitReminders", value: v, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  };

  const [ch] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, ch.agentId));
  const made: string[] = [];
  const mk = async (opts: { isTest?: boolean; handoff?: boolean } = {}) => {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "Lucía", isTest: Boolean(opts.isTest) } as never)
      .returning();
    made.push(c.id);
    await db.insert(messages).values({ conversationId: c.id, role: "user", text: "Покажете виллу в субботу? Мой телефон +34 600 111 222", status: "sent" } as never);
    await db.insert(messages).values({ conversationId: c.id, role: "assistant", text: "Да, запишу.", status: "sent" } as never);
    if (opts.handoff) await db.insert(messages).values({ conversationId: c.id, role: "system", text: "handoff", status: "sent" } as never);
    return c.id;
  };
  const { updateLead, flushHotAlerts } = await import("@/lib/agent/lead");
  const alerts = () => sent.filter((t) => t.includes("Горячий клиент сейчас в чате"));

  await hours(true);
  const a = await mk();
  await updateLead(a);
  const first = alerts().length;
  await updateLead(a); // клиент дописал — карточка снова горячая
  const once = alerts().length;
  const b = await mk({ handoff: true });
  await updateLead(b);
  const afterHandoff = alerts().length;
  const t = await mk({ isTest: true });
  await updateLead(t);
  const afterTest = alerts().length;

  await hours(false);
  const n = await mk();
  await updateLead(n);
  const night = alerts().length;
  const [nc] = await db.select().from(conversations).where(eq(conversations.id, n));
  await hours(true);
  await flushHotAlerts();
  const morning = alerts().length;
  const text = alerts().at(-1) ?? "";

  for (const id of made) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  await db.delete(settings).where(inArray(settings.key, ["notify", "waitReminders"]));
  for (const k of keep) await db.insert(settings).values(k);
  stub.close();

  const checks: Record<string, boolean> = {
    "горячий, менеджер не знает — оповещение": first === 1,
    "второй раз в этом разговоре — нет": once === 1,
    "уже передан менеджеру — нет": afterHandoff === 1,
    "тестовый разговор — нет": afterTest === 1,
    "ночью — откладываем": night === 1 && nc.context?.hotAlertPending === true,
    "утром — отправлено": morning === 2,
    "в тексте — карточка и слова клиента": text.includes("🔥 Горячий") && text.includes("вилла с бассейном") && text.includes("Покажете виллу в субботу"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
