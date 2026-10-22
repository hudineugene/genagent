"use server";

import { redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, agentVersions, clients, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n/server";
import { agentConfigSchema, type AgentConfig } from "@/lib/agent/types";
import { TEMPLATE_MAP, configFromTemplate, emptyConfig } from "@/lib/agent/templates";
import { generateAgentConfig } from "@/lib/agent/generate";

async function insertAgent(clientId: string, name: string, config: AgentConfig, templateKey: string | null, userId: string) {
  const [a] = await db
    .insert(agents)
    .values({ clientId, name, config, templateKey })
    .returning({ id: agents.id });
  await db.insert(agentVersions).values({ agentId: a.id, version: 1, name, config, createdBy: userId });
  return a.id;
}

export async function createAgent(clientId: string, templateKey: string | null) {
  const user = await requireUser();
  const locale = await getLocale();
  const template = templateKey ? TEMPLATE_MAP.get(templateKey) : undefined;
  const name = template?.name[locale] ?? (locale === "uk" ? "Новий агент" : "Новый агент");
  const id = await insertAgent(clientId, name, configFromTemplate(templateKey), template?.key ?? null, user.id);
  redirect(`/agents/${id}`);
}

export async function generateAgent(
  clientId: string,
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const user = await requireUser();
  const brief = String(formData.get("brief") ?? "").trim();
  if (brief.length < 10) return { error: "brief" };

  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return { error: "not_found" };

  let id: string;
  try {
    const g = await generateAgentConfig(brief, client);
    const config: AgentConfig = { ...emptyConfig(), ...g.config };
    id = await insertAgent(clientId, g.name, config, null, user.id);
  } catch (e) {
    console.error("generateAgent failed", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
  redirect(`/agents/${id}`);
}

const saveSchema = z.object({
  name: z.string().trim().min(1).max(200),
  status: z.enum(["draft", "active", "paused"]),
  config: agentConfigSchema,
});

export async function saveAgent(id: string, input: z.input<typeof saveSchema>) {
  const user = await requireUser();
  const data = saveSchema.parse(input);
  const [a] = await db
    .update(agents)
    .set({
      name: data.name,
      status: data.status,
      config: data.config,
      version: sql`${agents.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, id))
    .returning({ version: agents.version });
  if (!a) throw new Error("Agent not found");
  await db
    .insert(agentVersions)
    .values({ agentId: id, version: a.version, name: data.name, config: data.config, createdBy: user.id });
  // Ключевые факты или правила могли разойтись с базой знаний — сверить (с паузой)
  void import("@/lib/agent/consistency").then((m) => m.scheduleConsistency(id));
  return { version: a.version };
}

export async function deleteAgent(id: string) {
  await requireUser();
  const [a] = await db.delete(agents).where(eq(agents.id, id)).returning({ clientId: agents.clientId });
  redirect(a ? `/clients/${a.clientId}` : "/");
}

export type AgentVersionItem = {
  id: string;
  version: number;
  name: string | null;
  config: AgentConfig;
  author: string | null;
  createdAt: Date;
};

/** История сохранений агента, новые сверху. */
export async function listVersions(agentId: string): Promise<AgentVersionItem[]> {
  await requireUser();
  return db
    .select({
      id: agentVersions.id,
      version: agentVersions.version,
      name: agentVersions.name,
      config: agentVersions.config,
      author: users.name,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .leftJoin(users, eq(users.id, agentVersions.createdBy))
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .limit(100);
}
