/**
 * База знаний «документы бота + большие справочники» на копии базы (без ИИ):
 * DB_PATH=<копия caltest> npx tsx scripts/test-kb-hybrid.ts "<имя клиента>"
 * Документы бота — целиком в промпте, справочники — найденными фрагментами по вопросу.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { loadKnowledge, knowledgeSummary } from "@/lib/kb/store";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const [client] = await db.select().from(clients).where(eq(clients.name, process.argv[2]));
  const summary = await knowledgeSummary(client.id, null);
  const tax = await loadKnowledge(client.id, null, ["Какие налоги я буду платить каждый год, если не живу в Испании?"]);
  const sanctions = await loadKnowledge(client.id, null, ["Я гражданин России, смогу ли я оплатить квартиру?"]);
  const show = (k: Awaited<ReturnType<typeof loadKnowledge>>) =>
    k.mode === "search" ? { mode: k.mode, pinned: k.pinned?.map((d) => d.title), used: k.used.map((u) => u.title), contextChars: k.context?.length ?? 0, hasIBI: k.context?.includes("IBI"), has5b: k.context?.includes("100 000") } : { mode: k.mode };
  console.log({ summary, tax: show(tax), sanctions: show(sanctions) });
  const ok = summary.mode === "search" && tax.mode === "search" && Boolean(tax.pinned?.length) && Boolean(tax.context?.includes("IBI")) && sanctions.mode === "search" && Boolean(sanctions.context?.includes("100 000"));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
