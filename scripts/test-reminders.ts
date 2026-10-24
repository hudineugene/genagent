/** Напоминания по таблице (по дате и по смене статуса) и прогноз повторных покупок: кому, когда, в чат или на
 *  почту, без повторов, первый проход по статусам только запоминает. Модель, Telegram и почта — макеты.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-reminders.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientRepeat, clients, conversations, dataTables, reminders } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  const prompts: string[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        const b = JSON.parse(body || "{}");
        if (req.url.endsWith("/sendMessage")) tg.push({ chat: String(b.chat_id), text: b.text });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      const b = JSON.parse(body);
      prompts.push(String(b.messages[0].content));
      const text = JSON.stringify({ text: "Анна, пора пополнить запас кофе — оформить как обычно?" });
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
  await new Promise<void>((r) => stub.listen(4069, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4069";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4069";
  process.env.EMAIL_TEST_JSON = "1";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Reminders Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "rem-agent" }).returning();
  const [tgCh] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "123:t" } as never }).returning();
  const [mail] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "email", name: "pay@test.local", config: { address: "pay@test.local", password: "x", imapHost: "x", imapPort: 993, smtpHost: "x", smtpPort: 465, fromName: "Бухгалтерия" } as never, enabled: false }).returning();
  await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tgCh.id, channelType: "telegram", externalId: "501", contactName: "Иван", contactHandle: "@ivan_p" });
  await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tgCh.id, channelType: "telegram", externalId: "502", contactName: "Анна", contactHandle: "@anna_k" });

  const { buildTable } = await import("@/lib/data/tables");
  const { runReminder, remindersTick, renderTemplate, dateHits } = await import("@/lib/reminders");
  const { testOutbox } = await import("@/lib/channels/email-send");

  // Счета: срок оплаты, статус, контакт
  const bills = buildTable([
    ["Счёт", "Клиент", "Контакт", "Сумма", "Оплатить до", "Статус"],
    ["101", "Иван", "@ivan_p", "1 200 €", "26.10.2026", "не оплачен"],
    ["102", "ООО Ромашка", "buh@romashka.example", "500 €", "26.10.2026", "не оплачен"],
    ["103", "Пётр", "@petr", "300 €", "26.10.2026", "оплачен"],
    ["104", "Олег", "@ivan_p", "50 €", "30.11.2026", "не оплачен"],
  ]);
  const [billsT] = await db.insert(dataTables).values({ clientId: c.id, name: "Счета", columns: bills.columns, rows: bills.rows, rowCount: bills.rows.length, refreshedAt: new Date() }).returning();
  const [r1] = await db
    .insert(reminders)
    .values({ clientId: c.id, name: "Оплата счетов", tableId: billsT.id, kind: "date", dateColumn: "Оплатить до", offsetDays: 2, keyColumn: "Счёт", statusColumn: "Статус", statusValues: ["Не оплачен"], contactColumn: "Контакт", channelId: mail.id, message: "{{Клиент}}, напоминаем: счёт №{{Счёт}} на {{Сумма}} — оплатить до {{оплатить до}}.", hour: 10, notifyTeam: true, enabled: true })
    .returning();
  const at = new Date("2026-10-24T08:00:00Z"); // 11:00 по Киеву, за 2 дня до 26.10
  const hits = dateHits(r1, bills, "2026-10-24");
  const first = await runReminder(r1, at);
  const again = await runReminder(r1, at);
  const ivanMsg = tg.find((x) => x.chat === "501");
  const buhMail = testOutbox.find((m) => m.to === "buh@romashka.example");
  const early = dateHits(r1, bills, "2026-10-20").length;

  // Статусы заказов: первый проход запоминает, потом — только изменения (и только «Отправлен»/«Доставлен»)
  const orders = buildTable([
    ["Заказ", "Контакт", "Статус", "Трек"],
    ["A-1", "@anna_k", "Принят", ""],
    ["A-2", "@ivan_p", "Отправлен", "NP123"],
  ]);
  const [ordT] = await db.insert(dataTables).values({ clientId: c.id, name: "Заказы", columns: orders.columns, rows: orders.rows, rowCount: 2, refreshedAt: new Date() }).returning();
  const [r2] = await db
    .insert(reminders)
    .values({ clientId: c.id, name: "Статус заказа", tableId: ordT.id, kind: "status", keyColumn: "Заказ", statusColumn: "Статус", statusValues: ["Отправлен", "Доставлен"], contactColumn: "Контакт", message: "Заказ {{Заказ}}: {{Статус}}. {{Трек}}", enabled: true })
    .returning();
  const tgBefore = tg.length;
  const base = await runReminder(r2, at);
  const silent = tg.length === tgBefore;
  await db.update(dataTables).set({ rows: [["A-1", "@anna_k", "Отправлен", "NP777"], ["A-2", "@ivan_p", "Отправлен", "NP123"], ["A-3", "@anna_k", "Принят", ""]] }).where(eq(dataTables.id, ordT.id));
  const changed = await runReminder(r2, at);
  const annaShip = tg.find((x) => x.chat === "502" && x.text.includes("A-1"));
  const changedAgain = await runReminder(r2, at);
  const nightTick = await remindersTick(new Date("2026-10-24T23:30:00Z"));

  // Повторные покупки
  const { predictRepeat, runRepeat } = await import("@/lib/repeat");
  const sales = buildTable([
    ["Клиент", "Дата", "Контакт", "Товар", "Сумма"],
    ["Анна", "2026-08-01", "@anna_k", "Кофе", "20"],
    ["Анна", "2026-08-31", "@anna_k", "Кофе", "20"],
    ["Анна", "2026-09-30", "@anna_k", "Кофе", "22"],
    ["Борис", "2026-06-01", "boris@x.example", "Чай", "10"],
    ["Борис", "2026-07-01", "boris@x.example", "Чай", "10"],
    ["Вера", "2026-10-01", "@vera", "Кофе", "15"],
    ["Гена", "2026-01-10", "@gena", "Чай", "5"],
    ["Гена", "2026-02-10", "@gena", "Чай", "5"],
  ]);
  const cfg = { customerColumn: "Клиент", dateColumn: "Дата", contactColumn: "Контакт", productColumn: "Товар", amountColumn: "Сумма", leadDays: 3, minOrders: 2 };
  const list = predictRepeat(cfg, sales, "2026-10-28");
  const anna = list.find((x) => x.customer === "Анна");
  const gena = list.find((x) => x.customer === "Гена");
  const [salesT] = await db.insert(dataTables).values({ clientId: c.id, name: "Продажи", columns: sales.columns, rows: sales.rows, rowCount: sales.rows.length, refreshedAt: new Date() }).returning();
  await db.insert(clientRepeat).values({ clientId: c.id, tableId: salesT.id, ...cfg, brief: "Напомнить пополнить запас", auto: true });
  const tgRep = tg.length;
  const rep1 = await runRepeat(c.id, new Date("2026-10-28T09:00:00Z"));
  const annaNudge = tg.slice(tgRep).find((x) => x.chat === "502");
  const rep2 = await runRepeat(c.id, new Date("2026-10-28T09:00:00Z"));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const result: Record<string, boolean> = {
    "шаблон: {{Столбец}} без учёта регистра": renderTemplate("{{клиент}} / {{Сумма}} / {{нет}}", ["Клиент", "Сумма"], ["Иван", "5"]) === "Иван / 5 / ",
    "по дате: за 2 дня, только «не оплачен», не раньше срока": hits.map((h) => h.key).join() === "101,102" && early === 0,
    "в чат по @нику и письмом с почтового канала": first.sent === 2 && ivanMsg?.text === "Иван, напоминаем: счёт №101 на 1 200 € — оплатить до 26.10.2026." && buhMail?.from === "pay@test.local" && buhMail.text.includes("№102"),
    "повторный проход не дублирует, команде — сводка": again.sent === 0 && tg.some((x) => x.text.includes("Оплата счетов") && x.text.includes("Отправлено напоминаний: 2")),
    "статусы: первый проход только запоминает": base.baseline === 2 && silent,
    "статусы: сообщение при смене на «Отправлен», новый «Принят» — нет": changed.sent === 1 && annaShip?.text === "Заказ A-1: Отправлен. NP777" && changedAgain.sent === 0,
    "ночью не пишем": nightTick === 0,
    "прогноз: интервал, дата, вероятность, статусы": anna?.interval === 30 && anna.nextDate === "2026-10-30" && anna.status === "due" && anna.probability >= 70 && gena?.status === "lost" && !list.some((x) => x.customer === "Вера"),
    "напоминание о повторной покупке — лично, один раз на цикл": rep1.sent === 1 && annaNudge?.text.includes("пополнить запас") === true && prompts.some((p) => p.includes("Обычно берёт: Кофе")) && rep2.sent === 0,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
