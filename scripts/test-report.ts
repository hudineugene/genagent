/**
 * Отчёт владельцу за месяц на копии базы (без ИИ): DB_PATH=<копия caltest> OUT=<файл.html> npx tsx scripts/test-report.ts
 * Добавляет тестовые разговоры и события за текущий месяц, строит отчёт, сохраняет HTML и всё удаляет.
 */
import { writeFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { agentEvents, channels, conversations, messages } from "@/db/schema";
import { clientReport, clientReportHtml } from "@/lib/agent/report";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const [channel] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const now = Date.now();
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" }).format(new Date(now)).slice(0, 7);
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const at = now - (i % 9) * 24 * 3_600_000 - 60_000;
    const [c] = await db
      .insert(conversations)
      .values({ clientId: channel.clientId, agentId: channel.agentId, channelId: channel.id, channelType: "widget", externalId: `report-${now}-${i}`, contactName: "" } as never)
      .returning();
    ids.push(c.id);
    await db.insert(messages).values([
      { conversationId: c.id, role: "user", text: "Сколько стоит?", createdAt: new Date(at) },
      { conversationId: c.id, role: "assistant", text: "От 1500 грн.", createdAt: new Date(at + 1000) },
      ...(i < 2 ? [{ conversationId: c.id, role: "system", text: "handoff", meta: i === 0 ? { upset: true } : {}, createdAt: new Date(at + 2000) }] : []),
    ] as never);
    if (i < 4) {
      await db.insert(agentEvents).values({ agentId: channel.agentId, clientId: channel.clientId, channelId: channel.id, conversationId: c.id, externalUserId: `report-${now}-${i}`, type: "order", label: "Заказ", value: 1500, assisted: true, createdAt: new Date(at + 3000) } as never);
    }
  }
  const r = await clientReport(channel.clientId, month);
  const html = r ? clientReportHtml(r) : "";
  if (process.env.OUT) writeFileSync(process.env.OUT, html);
  const checks: Record<string, boolean> = {
    "людей ≥ 12": (r?.people ?? 0) >= 12,
    "передано ≥ 2, недовольны ≥ 1": (r?.handedOff ?? 0) >= 2 && (r?.upset ?? 0) >= 1,
    "результат «Заказ» 4 чел.": r?.results.some((x) => x.label === "Заказ" && x.people === 4 && x.value === 6000) ?? false,
    "дни месяца": (r?.byDay.length ?? 0) >= 28,
    "html": html.includes("<svg") && html.includes(r?.client ?? "§"),
  };
  console.log(checks, r && { people: r.people, selfServed: r.selfServed, answers: r.answers, hours: r.hoursSaved });
  await db.delete(agentEvents).where(inArray(agentEvents.conversationId, ids));
  await db.delete(conversations).where(inArray(conversations.id, ids));
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
