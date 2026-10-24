"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { studioTemplates } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { requireClient, requireOwned, requireUnscoped } from "@/lib/access";
import { SYNC_FIELDS, agentFromTemplate, pushTemplate, saveAgentAsTemplate, type SyncField } from "@/lib/agent/studio-templates";

/** Сохранить агента как шаблон студии (новый или новая версия). */
export async function saveAsTemplateAction(agentId: string, input: { name: string; description: string; templateId: string | null }): Promise<{ error?: string; id?: string }> {
  await requireUnscoped();
  const user = await requireOwned("agent", agentId);
  const d = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(1000), templateId: z.string().nullable() }).safeParse(input);
  if (!d.success) return { error: "invalid" };
  const r = await saveAgentAsTemplate(agentId, d.data, user.id).catch(() => null);
  refresh();
  return r ? { id: r.id } : { error: "not_found" };
}

/** Новый агент клиента из шаблона. */
export async function createFromTemplateAction(clientId: string, templateId: string) {
  const user = await requireClient(clientId);
  const id = await agentFromTemplate(clientId, templateId, user.id);
  redirect(`/agents/${id}`);
}

/** Раскатить шаблон выбранным агентам (только к которым есть доступ) и только выбранные поля. */
export async function pushTemplateAction(templateId: string, agentIds: string[], fields: string[]): Promise<{ updated?: number; error?: string }> {
  const user = await requireUnscoped();
  const f = fields.filter((x): x is SyncField => (SYNC_FIELDS as readonly string[]).includes(x));
  for (const id of agentIds) await requireOwned("agent", id);
  const updated = await pushTemplate(templateId, agentIds.slice(0, 500), f, user.id);
  refresh();
  return { updated };
}

export async function deleteTemplateAction(id: string) {
  await requireAdmin();
  await db.delete(studioTemplates).where(eq(studioTemplates.id, id));
  refresh();
}
