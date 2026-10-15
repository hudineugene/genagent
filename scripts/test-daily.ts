/** Ежедневная сводка на копии базы (без ИИ и без отправки): DB_PATH=<копия caltest> npx tsx scripts/test-daily.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { channels, conversations, messages } from "@/db/schema";
import { dailyDigestHtml } from "@/lib/agent/daily";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const [channel] = await db.select().from(channels).limit(1);
  const now = Date.now();
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: channel.clientId, agentId: channel.agentId, channelId: channel.id, channelType: channel.type, externalId: "daily-" + now, contactName: "Анна", needsAttention: true } as never)
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Вы мне уже третий раз это пишете!", createdAt: new Date(now - 3000) },
    { conversationId: conv.id, role: "assistant", text: "Извините, передаю вопрос сотруднику.", createdAt: new Date(now - 2000) },
    { conversationId: conv.id, role: "system", text: "handoff", meta: { summary: "Недовольна ответами", upset: true }, createdAt: new Date(now - 1000) },
  ] as never);
  const html = await dailyDigestHtml(now - 60_000, "https://admin.example");
  console.log(html);
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  const ok = html.includes("Написали: 1") && html.includes("🔴 Недовольны: 1") && html.includes("Ждут человека: ") && html.includes(conv.id);
  console.log(ok ? "\nOK" : "\nFAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
