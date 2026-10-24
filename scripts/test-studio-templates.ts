/** Шаблоны агентов студии: шаблон без данных клиента (база знаний, инструменты, календарь); агент из шаблона помнит
 *  версию; новая версия шаблона — отличия видны по полям; раскатка — только выбранным агентам и выбранным полям,
 *  данные клиента не трогаются, у агента новая версия в истории.  DB_PATH=<копия caltest> npx tsx scripts/test-studio-templates.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentVersions, clients, studioTemplates, users } from "@/db/schema";
import { agentConfigSchema, type AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const st = await import("@/lib/agent/studio-templates");
  const [u] = await db.select({ id: users.id }).from(users).limit(1);
  const uid = u.id;
  const [c1] = await db.insert(clients).values({ name: "Tpl A" }).returning();
  const [c2] = await db.insert(clients).values({ name: "Tpl B" }).returning();
  const base = agentConfigSchema.parse({ model: "anthropic:claude-haiku-5-5" });
  const srcCfg: AgentConfig = { ...base, role: "Администратор клиники", rules: "Не ставить диагнозы", knowledge: "Секрет клиники A", kbSourceIds: ["kb-1"], toolIds: ["tool-1"], calendar: { ...base.calendar, enabled: true, calendarId: "a@clinic.com" } };
  const [src] = await db.insert(agents).values({ clientId: c1.id, name: "Админ A", config: srcCfg }).returning();
  const t1 = await st.saveAgentAsTemplate(src.id, { name: "Клиника", description: "Запись и вопросы", templateId: null }, uid);
  const [tpl] = await db.select().from(studioTemplates).where(eq(studioTemplates.id, t1.id));
  const newId = await st.agentFromTemplate(c2.id, t1.id, uid);
  const [made] = await db.select().from(agents).where(eq(agents.id, newId));
  // Клиент B дописал своё
  await db.update(agents).set({ config: { ...made.config, knowledge: "Прайс клиники B", greeting: "Привет от B" } }).where(eq(agents.id, newId));
  const [other] = await db.insert(agents).values({ clientId: c2.id, name: "Второй B", config: { ...made.config, studioTemplate: { id: t1.id, version: 1 } } }).returning();
  // Студия улучшила исходного агента → новая версия шаблона
  await db.update(agents).set({ config: { ...srcCfg, studioTemplate: { id: t1.id, version: 1 }, rules: "Не ставить диагнозы. Не называть цены лекарств.", tone: "formal" } }).where(eq(agents.id, src.id));
  const t2 = await st.saveAgentAsTemplate(src.id, { name: "Клиника", description: "v2", templateId: t1.id }, uid);
  const [tpl2] = await db.select().from(studioTemplates).where(eq(studioTemplates.id, t1.id));
  const [before] = await db.select().from(agents).where(eq(agents.id, newId));
  const diff = st.diffFields(agentConfigSchema.parse(before.config), agentConfigSchema.parse(tpl2.config));
  const n = await st.pushTemplate(t1.id, [newId], ["rules"], uid);
  const [after] = await db.select().from(agents).where(eq(agents.id, newId));
  const [untouched] = await db.select().from(agents).where(eq(agents.id, other.id));
  const versions = await db.select().from(agentVersions).where(eq(agentVersions.agentId, newId));

  await db.delete(studioTemplates).where(eq(studioTemplates.id, t1.id));
  for (const c of [c1, c2]) await db.delete(clients).where(eq(clients.id, c.id));

  const r: Record<string, boolean> = {
    "шаблон без данных клиента": tpl.config.knowledge === "" && tpl.config.kbSourceIds === null && !tpl.config.toolIds?.length && tpl.config.calendar.calendarId === "" && tpl.config.rules === "Не ставить диагнозы",
    "агент из шаблона помнит версию": made.clientId === c2.id && made.config.studioTemplate?.id === t1.id && made.config.studioTemplate.version === 1 && made.config.role === "Администратор клиники",
    "новая версия шаблона, отличия по полям": t2.version === 2 && tpl2.version === 2 && diff.includes("rules") && diff.includes("tone") && diff.includes("greeting") && !diff.includes("knowledge" as never),
    "раскатка: только выбранное поле, данные клиента на месте": n === 1 && after.config.rules.includes("цены лекарств") && after.config.tone !== "formal" && after.config.knowledge === "Прайс клиники B" && after.config.greeting === "Привет от B" && after.config.studioTemplate?.version === 2,
    "невыбранный агент не изменён": untouched.config.rules === "Не ставить диагнозы" && untouched.config.studioTemplate?.version === 1,
    "у агента новая версия в истории": versions.length === 2,
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
