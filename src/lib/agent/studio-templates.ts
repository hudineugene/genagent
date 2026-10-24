import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentVersions, studioTemplates } from "@/db/schema";
import { agentConfigSchema, type AgentConfig } from "./types";

/**
 * Шаблоны агентов студии. В шаблон попадает только переносимая часть настройки (роль, тон, правила, проверки,
 * модель…), без данных клиента: базы знаний, инструментов, анкет, таблиц, процедур, календаря, команды.
 * Раскатка новой версии — выбранным агентам и только выбранные поля; каждый агент получает новую версию
 * (её можно откатить в «Версиях»).
 */
export const SYNC_FIELDS = [
  "role",
  "description",
  "tone",
  "toneCustom",
  "replyLanguage",
  "skills",
  "rules",
  "handoff",
  "greeting",
  "extraInstructions",
  "leadFields",
  "model",
  "effort",
  "factGuard",
  "answerCheck",
  "qualityCheck",
  "aiDisclosure",
  "memory",
  "voiceReplies",
  "voice",
  "streaming",
  "quickReplies",
  "useBrandVoice",
] as const satisfies readonly (keyof AgentConfig)[];
export type SyncField = (typeof SYNC_FIELDS)[number];

/** Переносимая часть настройки агента (для шаблона). */
export function portable(config: AgentConfig): AgentConfig {
  const base = agentConfigSchema.parse({ model: config.model });
  const out: Record<string, unknown> = { ...base };
  for (const f of SYNC_FIELDS) if (config[f] !== undefined) out[f] = config[f];
  out.icon = config.icon;
  out.webSearch = config.webSearch;
  out.calendar = { ...base.calendar, ...config.calendar, calendarId: "" };
  return agentConfigSchema.parse(out);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Чем агент отличается от шаблона (по раскатываемым полям). */
export function diffFields(agent: AgentConfig, template: AgentConfig): SyncField[] {
  return SYNC_FIELDS.filter((f) => !same(agent[f], template[f]));
}

/** Сохранить агента как шаблон (новый или новая версия существующего). Агент становится «из этого шаблона». */
export async function saveAgentAsTemplate(agentId: string, input: { name: string; description: string; templateId: string | null }, userId: string) {
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) throw new Error("not_found");
  const config = portable(agentConfigSchema.parse(a.config));
  let id = input.templateId;
  let version = 1;
  if (id) {
    const [t] = await db
      .update(studioTemplates)
      .set({ name: input.name, description: input.description, config, version: sql`${studioTemplates.version} + 1`, updatedAt: new Date() })
      .where(eq(studioTemplates.id, id))
      .returning({ version: studioTemplates.version });
    if (!t) throw new Error("not_found");
    version = t.version;
  } else {
    const [t] = await db.insert(studioTemplates).values({ name: input.name, description: input.description, config, createdBy: userId }).returning({ id: studioTemplates.id });
    id = t.id;
  }
  await db.update(agents).set({ config: { ...a.config, studioTemplate: { id, version } } }).where(eq(agents.id, agentId));
  return { id, version };
}

/** Новый агент клиента из шаблона. */
export async function agentFromTemplate(clientId: string, templateId: string, userId: string) {
  const [t] = await db.select().from(studioTemplates).where(eq(studioTemplates.id, templateId));
  if (!t) throw new Error("not_found");
  const config: AgentConfig = { ...agentConfigSchema.parse(t.config), studioTemplate: { id: t.id, version: t.version } };
  const [a] = await db.insert(agents).values({ clientId, name: t.name, config, templateKey: null }).returning({ id: agents.id });
  await db.insert(agentVersions).values({ agentId: a.id, version: 1, name: t.name, config, createdBy: userId });
  return a.id;
}

/** Раскатить шаблон: выбранным агентам — выбранные поля; новая версия у каждого агента. */
export async function pushTemplate(templateId: string, agentIds: string[], fields: SyncField[], userId: string) {
  const [t] = await db.select().from(studioTemplates).where(eq(studioTemplates.id, templateId));
  if (!t) throw new Error("not_found");
  const tpl = agentConfigSchema.parse(t.config);
  let n = 0;
  for (const id of agentIds) {
    const [a] = await db.select().from(agents).where(eq(agents.id, id));
    if (!a || a.config.studioTemplate?.id !== templateId) continue;
    const next: AgentConfig = { ...a.config, studioTemplate: { id: t.id, version: t.version } };
    for (const f of fields) (next as Record<string, unknown>)[f] = tpl[f];
    const config = agentConfigSchema.parse(next);
    const [u] = await db
      .update(agents)
      .set({ config, version: sql`${agents.version} + 1`, updatedAt: new Date() })
      .where(eq(agents.id, id))
      .returning({ version: agents.version, name: agents.name });
    await db.insert(agentVersions).values({ agentId: id, version: u.version, name: u.name, config, createdBy: userId });
    n++;
  }
  return n;
}
