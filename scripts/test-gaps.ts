/** Разбор «вопросов без ответа» на копии базы: DB_PATH=<копия> npx tsx --env-file=.env scripts/test-gaps.ts <agentId> */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { knowledgeGaps } from "@/db/schema";
import { analyzeGaps } from "@/lib/agent/gaps";

async function main() {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const agentId = process.argv[2];
  console.log("разбор:", await analyzeGaps(agentId));
  for (const g of await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.agentId, agentId))) {
    console.log(`\n• ${g.question} (×${g.count})\n  не хватает: ${g.missing}\n  пример: ${g.examples[0]?.quote.slice(0, 100)}`);
  }
  console.log("\nповторный разбор (новых переписок нет):", await analyzeGaps(agentId));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
