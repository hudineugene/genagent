/** Честный срок ответа менеджера: правило для агента (данные бота / свои замеры / ничего) и замеры по истории.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-eta.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { handoffEtaNote, measuredReplyMinutes } = await import("@/lib/agent/eta");
  const now = Date.now();
  const closed = handoffEtaNote({ open: false, next: "завтра з 10:00", at: now }, 3);
  const open = handoffEtaNote({ open: true, minutes: 25, at: now }, 3);
  const openNoNumber = handoffEtaNote({ open: true, at: now }, 3);
  const measured = handoffEtaNote(undefined, 90);
  const nothing = handoffEtaNote(undefined, null);
  const stale = handoffEtaNote({ open: false, next: "завтра з 10:00", at: now - 60 * 60 * 1000 }, null);

  // Замеры: отдельный канал-копия с 6 передачами (ответы через 2,4,6,8,10,60 мин) и одной без ответа
  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [copy] = await db.insert(channels).values({ agentId: ch.agentId, clientId: ch.clientId, type: "api", name: "eta-test", enabled: false, config: ch.config }).returning();
  const waits = [2, 4, 6, 8, 10, 60, null];
  for (const [i, w] of waits.entries()) {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: copy.id, channelType: "api", externalId: `eta-${i}` })
      .returning();
    const t = now - 24 * 60 * 60 * 1000 + i * 1000;
    await db.insert(messages).values({ conversationId: c.id, role: "system", text: "handoff", status: "sent", createdAt: new Date(t) });
    if (w !== null) await db.insert(messages).values({ conversationId: c.id, role: "operator", text: "Вітаю!", status: "sent", createdAt: new Date(t + w * 60000) });
  }
  const minutes = await measuredReplyMinutes(copy.id);
  const [empty] = await db.insert(channels).values({ agentId: ch.agentId, clientId: ch.clientId, type: "api", name: "eta-empty", enabled: false, config: ch.config }).returning();
  const none = await measuredReplyMinutes(empty.id);
  await db.delete(channels).where(eq(channels.id, copy.id));
  await db.delete(channels).where(eq(channels.id, empty.id));

  const checks: Record<string, boolean> = {
    "нерабочее время — когда ответят": closed.includes("нерабочее время") && closed.includes("завтра з 10:00") && !closed.includes("3 мин"),
    "рабочее время — срок от бота": open.includes("примерно за 25 мин") && !open.includes("за последний месяц"),
    "бот не дал срок — без чисел (замер не подставляем)": openNoNumber.includes("не называй минут"),
    "бот молчит — свой замер": measured.includes("примерно за 2 ч") && measured.includes("за последний месяц"),
    "нет данных — без чисел": nothing.includes("не называй минут"),
    "устаревшие данные бота не используем": stale.includes("не называй минут"),
    "медиана по истории (6 случаев)": minutes === 6,
    "мало данных — null": none === null,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
