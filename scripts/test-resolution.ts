/** Итоги обращений по переписке: подтверждено (запись, оплата, 👍, благодарность), передано, клиент вернулся,
 *  без жалоб, открыто; доля решённых по агентам; источники клиентов с оплатами.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-resolution.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, payments } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { classify, resolutionStats, sourceStats } = await import("@/lib/agent/resolution");
  const now = Date.now();
  const h = (n: number) => new Date(now - n * 3600_000);
  const m = (role: string, text: string, hoursAgo: number, meta: object | null = null) => ({ role, text, createdAt: h(hoursAgo), meta });

  const cases: Record<string, boolean> = {
    "передача менеджеру": classify([m("user", "Хочу вернуть", 50), m("system", "handoff", 49)], now) === "escalated",
    "запись в календарь": classify([m("user", "Запишите", 50), m("system", "booking_created", 49), m("assistant", "Записал", 49)], now) === "confirmed",
    "благодарность после ответа": classify([m("user", "Сколько стоит?", 50), m("assistant", "450 €", 49), m("user", "Спасибо!", 48)], now) === "confirmed",
    "«спасибо, а ещё вопрос?» — не подтверждение": classify([m("user", "Сколько?", 4), m("assistant", "450", 3), m("user", "Спасибо, а доставка есть?", 2)], now) === "open",
    "👍 на ответ": classify([m("user", "?", 50), m("assistant", "ответ", 49, { rating: "up" })], now) === "confirmed",
    "оплата по ссылке": classify([m("user", "?", 50), m("assistant", "ссылка", 49)], now, true) === "confirmed",
    "вернулся через 2 дня": classify([m("user", "Где заказ?", 100), m("assistant", "В пути", 99), m("user", "Так и не пришёл", 50), m("assistant", "Проверю", 49)], now) === "returned",
    "молчит после ответа больше суток": classify([m("user", "Часы работы?", 30), m("assistant", "9–18", 30)], now) === "assumed",
    "ответ моложе суток — открыто": classify([m("user", "Часы работы?", 3), m("assistant", "9–18", 3)], now) === "open",
  };

  // Сводка по агенту и источники
  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Resolution Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "res-agent" }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
  const mk = async (ext: string, msgs: ReturnType<typeof m>[], source?: object) => {
    const [conv] = await db
      .insert(conversations)
      .values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: ext, contactName: ext, lastMessageAt: msgs.at(-1)!.createdAt, context: source ? { source } : null, createdAt: h(60) } as never)
      .returning();
    for (const x of msgs) await db.insert(messages).values({ conversationId: conv.id, role: x.role, text: x.text, createdAt: x.createdAt, meta: x.meta } as never);
    return conv;
  };
  const paidConv = await mk("ad1", [m("user", "Диван", 40), m("assistant", "Ссылка", 39)], { kind: "ad", title: "Диваны -20%", at: now });
  await db.insert(payments).values({ clientId: c.id, conversationId: paidConv.id, provider: "liqpay", orderId: `t-${now}`, amount: 1200, currency: "UAH", description: "Диван", status: "paid", url: "x" });
  await mk("ad2", [m("user", "Диван?", 40), m("system", "handoff", 39)], { kind: "ad", title: "Диваны -20%", at: now });
  await mk("d1", [m("user", "Адрес?", 40), m("assistant", "Киев", 39)]);
  await mk("d2", [m("user", "Адрес?", 2)]);
  const from = h(24 * 7);
  const stats = await resolutionStats(from, c.id, now);
  const src = await sourceStats(from, c.id);
  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));

  const ag = stats.byAgent.get(a.id);
  const ad = src.find((s) => s.kind === "ad");
  const r: Record<string, boolean> = {
    ...cases,
    "по агенту: 1 оплата, 1 передача, 1 без жалоб, 1 открыт → решено 2 из 3": stats.all.total === 4 && stats.all.confirmed === 1 && stats.all.escalated === 1 && stats.all.assumed === 1 && stats.all.open === 1 && Math.round((ag?.rate ?? 0) * 100) === 67,
    "источник «реклама»: 2 разговора, 1 оплата, выручка": ad?.conversations === 2 && ad.paid === 1 && ad.revenue === "1200 UAH" && ad.title === "Диваны -20%" && src.some((s) => s.kind === "direct" && s.conversations === 2),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
