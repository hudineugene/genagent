/** A/B-проверка версий: новый разговор попадает в B по доле, вариант закрепляется за разговором, начатые раньше
 *  разговоры остаются на A, в B отвечает настройка выбранной версии; итоги по вариантам; остановка — все на A.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-experiments.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentVersions, channels, clients, conversations, messages } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const ex = await import("@/lib/agent/experiments");
  const [c] = await db.insert(clients).values({ name: "AB Test" }).returning();
  const base = agentConfigSchema.parse({ model: "anthropic:claude-haiku-5-5", rules: "Правила A" });
  const [a] = await db.insert(agents).values({ clientId: c.id, name: "ab-agent", config: base }).returning();
  const [vb] = await db.insert(agentVersions).values({ agentId: a.id, version: 2, name: "ab", config: { ...base, rules: "Правила B" } }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
  const mk = async (ext: string) => (await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: ext, contactName: "X" }).returning())[0];

  const noExp = await ex.pickVariant(a.id, await mk("e0"), base, false, 0.01);
  await ex.startExperiment(a.id, vb.id, 20);
  const c1 = await mk("e1");
  const toB = await ex.pickVariant(a.id, c1, base, false, 0.05);
  const [c1s] = await db.select().from(conversations).where(eq(conversations.id, c1.id));
  const stickB = await ex.pickVariant(a.id, c1s, base, true, 0.99);
  const toA = await ex.pickVariant(a.id, await mk("e2"), base, false, 0.5);
  const old = await ex.pickVariant(a.id, await mk("e3"), base, true, 0.01);
  await db.insert(messages).values([
    { conversationId: c1.id, role: "user", text: "Вопрос", createdAt: new Date(Date.now() - 3 * 86400_000) },
    { conversationId: c1.id, role: "assistant", text: "Ответ", createdAt: new Date(Date.now() - 3 * 86400_000 + 1000) },
  ] as never);
  await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, c1.id));
  const stats = await ex.experimentStats(a.id);
  await ex.stopExperiment(a.id);
  const after = await ex.pickVariant(a.id, c1s, base, true, 0.01);

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));

  const r: Record<string, boolean> = {
    "без проверки — основная настройка": noExp.variant === null && noExp.config.rules === "Правила A",
    "новый разговор в доле — B, отвечает настройка версии": toB.variant === "B" && toB.config.rules === "Правила B" && c1s.context?.variant === `B:${vb.id}`,
    "вариант закреплён за разговором": stickB.variant === "B",
    "вне доли — A": toA.variant === "A" && toA.config.rules === "Правила A",
    "разговоры, где агент уже отвечал, — на A": old.variant === "A",
    "итоги по вариантам": stats.B.conversations === 1 && stats.B.resolved === 1 && stats.A.conversations >= 2,
    "остановка — снова основная настройка": after.config.rules === "Правила A",
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
