/** Фоновое наблюдение на копии базы (Telegram — заглушка, без ИИ): DB_PATH=<копия caltest> npx tsx scripts/test-watch.ts */
import http from "node:http";
import { eq, like } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { channels, kbSources, settings, usageLog } from "@/db/schema";
import { setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const sent: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (body) sent.push(JSON.parse(body).text ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(4016, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4016";
  const [oldNotify] = await db.select().from(settings).where(eq(settings.key, "notify"));
  const notifyValue = { token: "1:T", botUsername: "b", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "7", name: "QA", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value: notifyValue, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: notifyValue } });

  const [ch] = await db.select().from(channels).limit(1);
  const now = Date.now();
  // всплеск расходов: неделя по $0.01, последний час — $2
  const rows = Array.from({ length: 20 }, (_, i) => ({ source: "channel", clientId: ch.clientId, agentId: ch.agentId, model: "anthropic:claude-haiku-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cost: 0.01, ms: 1, createdAt: new Date(now - (i + 2) * 3600_000) }));
  rows.push({ ...rows[0], cost: 2, createdAt: new Date(now - 60_000) });
  await db.insert(usageLog).values(rows as never);
  // бот замолчал: свой бот с документами бота, синхронизация 2 дня назад
  const [api] = await db.insert(channels).values({ clientId: ch.clientId, agentId: ch.agentId, type: "api", name: "watch-test-bot", config: { key: "ga_w", label: "w" } } as never).returning();
  const [botDoc] = await db.insert(kbSources).values({ clientId: ch.clientId, type: "text", title: "watch-bot-doc", externalKey: "watchdoc", content: "x", chars: 1, chunks: 0, status: "ready" } as never).returning();
  await setSetting(`kbSyncAt:${api.id}`, now - 2 * 86_400_000);
  // старый справочник
  const [ref] = await db.insert(kbSources).values({ clientId: ch.clientId, type: "text", title: "watch-old-reference", content: "y".repeat(6000), chars: 6000, chunks: 0, status: "ready", updatedAt: new Date(now - 200 * 86_400_000) } as never).returning();

  const { runWatch } = await import("@/lib/agent/watch");
  await runWatch();
  const first = [...sent];
  sent.length = 0;
  await runWatch();
  const checks: Record<string, boolean> = {
    "всплеск расходов": first.some((t) => t.includes("Резкий рост расходов") && t.includes("$2.00")),
    "бот замолчал": first.some((t) => t.includes("не обновляет базу знаний") && t.includes("watch-test-bot")),
    "старый справочник": first.some((t) => t.includes("давно не обновлялся") && t.includes("watch-old-reference")),
    "повторно сразу не шлёт": sent.length === 0,
  };
  console.log(checks);

  await db.delete(usageLog).where(eq(usageLog.ms, 1));
  await db.delete(kbSources).where(eq(kbSources.id, botDoc.id));
  await db.delete(kbSources).where(eq(kbSources.id, ref.id));
  await db.delete(channels).where(eq(channels.id, api.id));
  await db.delete(settings).where(like(settings.key, "watch:%"));
  await db.delete(settings).where(eq(settings.key, `kbSyncAt:${api.id}`));
  if (oldNotify) await db.update(settings).set({ value: oldNotify.value }).where(eq(settings.key, "notify"));
  else await db.delete(settings).where(eq(settings.key, "notify"));
  server.close();
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
