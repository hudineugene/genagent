/** Биллинг: счёт = абонплата + ИИ сверх включённого с наценкой + WhatsApp с наценкой по курсу; расходы по ключам
 *  клиента в счёт не входят; маржа; лимит — на 80% одно предупреждение, на 100% агенты клиента молчат (сигнал
 *  «client_limit»), предупреждения не повторяются. Telegram — заглушка.  DB_PATH=<копия caltest> npx tsx scripts/test-billing.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientBilling, clients, conversations, messages, usageLog } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.includes("/sendMessage")) sent.push(JSON.parse(body || "{}").text ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(4083, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4083";
  const billing = await import("@/lib/billing");

  const math = billing.computeBill({ ...billing.DEFAULT_BILLING, usdRate: 40, fee: 1000, includedUsd: 5, markupPct: 50, channelMarkupPct: 10 }, { ai: 15, ownKey: 99, channel: 2 });

  const [c] = await db.insert(clients).values({ name: "Billing Test" }).returning();
  const add = (cost: number, model: string, ownKey = false) => db.insert(usageLog).values({ source: "channel", clientId: c.id, model, cost, ownKey });
  await add(6, "anthropic:claude-haiku-5-5");
  await add(3, "openai:gpt", true);
  await add(1, "whatsapp:template");
  await db.insert(clientBilling).values({ clientId: c.id, currency: "UAH", usdRate: 41, fee: 2000, markupPct: 100, channelMarkupPct: 0, includedUsd: 2, limitUsd: 8.5 });
  const month = billing.currentMonth();
  const [bill] = await billing.bills(month, c.id);
  const over80 = await billing.clientOverLimit(c.id);
  const again80 = await billing.clientOverLimit(c.id);
  await add(2, "anthropic:claude-haiku-5-5");
  const over100 = await billing.clientOverLimit(c.id);
  const again100 = await billing.clientOverLimit(c.id);

  // Агент клиента молчит при исчерпанном лимите
  const [agent] = await db.select().from(agents).limit(1);
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "bill-agent", status: "active" }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
  const [conv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: "bill-1", contactName: "X" }).returning();
  await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Привет" } as never);
  const { respond } = await import("@/lib/conversations");
  await respond(conv.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id));

  await db.delete(usageLog).where(eq(usageLog.clientId, c.id));
  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "расчёт: абонплата + ИИ сверх включённого с наценкой + каналы с наценкой по курсу": math.aiBilled === 600 && math.channelBilled === 88 && math.total === 1688 && math.margin === 1688 - 17 * 40,
    "счёт клиента: свои ключи не входят, валюта и маржа": bill.aiCost === 6 && bill.aiOwnKey === 3 && bill.channelCost === 1 && bill.currency === "UAH" && bill.aiBilled === 328 && bill.channelBilled === 41 && bill.total === 2369 && bill.margin === 2369 - 7 * 41,
    "80% — предупреждение один раз, агенты работают": !over80 && !again80 && sent.filter((x) => x.includes("80%")).length === 1,
    "100% — агенты молчат, одно сообщение команде": over100 && again100 && sent.filter((x) => x.includes("исчерпан")).length === 1,
    "ответа нет, разговор помечен для менеджера": !msgs.some((m) => m.role === "assistant") && msgs.some((m) => m.role === "system" && m.text.includes("client_limit")),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
