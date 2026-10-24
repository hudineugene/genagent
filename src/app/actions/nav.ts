"use server";

import { and, count, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, knowledgeGaps } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { canClient, inScope, scopeOf } from "@/lib/access";
import { getT } from "@/lib/i18n/server";
import { logoVersions } from "@/lib/client-logo";
import type { AgentConfig } from "@/lib/agent/types";
import type { SectionGroup } from "@/lib/nav-icons";

export type NavClient = { id: string; name: string; color: string; logoV: number; agents: number; waiting: number };
export type NavAgent = { id: string; name: string; icon: string; status: "draft" | "active" | "paused" };
export type NavCtx =
  | { kind: "clients"; clients: NavClient[] }
  | { kind: "client"; clients: NavClient[]; client: NavClient & { industry: string }; nav: SectionGroup[]; agents: NavAgent[] }
  | { kind: "agent"; clients: NavClient[]; client: NavClient & { industry: string }; agent: NavAgent & { channels: number; gaps: number; proposals: number }; agents: NavAgent[] };

const agentOf = (a: { id: string; name: string; status: NavAgent["status"]; config: unknown }): NavAgent => ({ id: a.id, name: a.name, status: a.status, icon: (a.config as AgentConfig).icon || "🤖" });

/**
 * Панель слева и путь вверху: что показать для открытой страницы. На общих страницах — клиенты (с логотипами и
 * числом ждущих), внутри клиента — его разделы и агенты, внутри агента — его вкладки со счётчиками и соседние агенты.
 * Чужие клиенты сотруднику с ограниченным доступом не видны.
 */
export async function navContext(pathname: string): Promise<NavCtx> {
  const user = await requireUser();
  const ids = scopeOf(user);
  const [rows, agentRows, waitRows, logos] = await Promise.all([
    db.select({ id: clients.id, name: clients.name, color: clients.color, industry: clients.industry }).from(clients).where(inScope(clients.id, ids)).orderBy(desc(clients.createdAt)),
    db.select({ id: agents.id, clientId: agents.clientId, name: agents.name, status: agents.status, config: agents.config }).from(agents).where(inScope(agents.clientId, ids)).orderBy(agents.createdAt),
    db
      .select({ clientId: conversations.clientId, n: count() })
      .from(conversations)
      .where(and(eq(conversations.isTest, false), eq(conversations.needsAttention, true), ne(conversations.status, "closed"), inScope(conversations.clientId, ids)))
      .groupBy(conversations.clientId),
    logoVersions(),
  ]);
  const waiting = new Map(waitRows.map((w) => [w.clientId, w.n]));
  const list: NavClient[] = rows.map((c) => ({ id: c.id, name: c.name, color: c.color, logoV: logos.get(c.id) ?? 0, agents: agentRows.filter((a) => a.clientId === c.id).length, waiting: waiting.get(c.id) ?? 0 }));
  const full = (id: string) => {
    const c = list.find((x) => x.id === id);
    return c ? { ...c, industry: rows.find((r) => r.id === id)?.industry ?? "" } : null;
  };

  const agentMatch = pathname.match(/^\/agents\/([0-9a-f-]{36})/);
  if (agentMatch) {
    const a = agentRows.find((x) => x.id === agentMatch[1]);
    const client = a && canClient(user, a.clientId) ? full(a.clientId) : null;
    if (a && client) {
      const { getAgentReview } = await import("@/lib/agent/review");
      const [[{ n: ch }], [{ n: gaps }], review] = await Promise.all([
        db.select({ n: count() }).from(channels).where(eq(channels.agentId, a.id)),
        db.select({ n: count() }).from(knowledgeGaps).where(and(eq(knowledgeGaps.agentId, a.id), eq(knowledgeGaps.status, "open"))),
        getAgentReview(a.id),
      ]);
      return {
        kind: "agent",
        clients: list,
        client,
        agent: { ...agentOf(a), channels: ch, gaps, proposals: review?.proposals.filter((p) => p.status === "new").length ?? 0 },
        agents: agentRows.filter((x) => x.clientId === a.clientId).map(agentOf),
      };
    }
  }

  const clientMatch = pathname.match(/^\/clients\/([0-9a-f-]{36})/);
  const client = clientMatch && canClient(user, clientMatch[1]) ? full(clientMatch[1]) : null;
  if (client) {
    const { t } = await getT();
    const { clientSections } = await import("@/lib/client-sections");
    const { nav } = await clientSections(client.id, t);
    return { kind: "client", clients: list, client, nav, agents: agentRows.filter((x) => x.clientId === client.id).map(agentOf) };
  }
  return { kind: "clients", clients: list };
}

/** Колокольчик вверху: последние события по доступным клиентам (новые разговоры, передачи, горячие, оплаты). */
export async function bellFeed() {
  const user = await requireUser();
  const { homeFeed } = await import("@/lib/home-live");
  return homeFeed(scopeOf(user), 20);
}
