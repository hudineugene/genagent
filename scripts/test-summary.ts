/** Выжимка для менеджера на диалогах из копии базы: DB_PATH=<копия> npx tsx --env-file=.env scripts/test-summary.ts */
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { handoffSummary } from "@/lib/agent/summary";

async function main() {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const list = await db.select().from(conversations).where(eq(conversations.channelType, "api")).orderBy(desc(conversations.createdAt)).limit(6);
  for (const c of list) {
    const t = Date.now();
    const s = await handoffSummary(c.id, { agentId: c.agentId, clientId: c.clientId });
    console.log(`\n[${c.externalId}] ${((Date.now() - t) / 1000).toFixed(1)}s\n${s}`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
