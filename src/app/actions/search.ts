"use server";

import { and, desc, eq, like, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, clients, conversations } from "@/db/schema";
import { inScope, scopeOf } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import type { AgentConfig } from "@/lib/agent/types";

export type SearchHit =
  | { kind: "client"; id: string; title: string; subtitle: string; color: string }
  | { kind: "agent"; id: string; title: string; subtitle: string; icon: string }
  | { kind: "conversation"; id: string; title: string; subtitle: string; color: string };

/** Быстрый поиск (Ctrl K): клиенты, агенты и диалоги по имени. Пустой запрос — клиенты, агенты и свежие диалоги. */
export async function searchAll(query: string): Promise<SearchHit[]> {
  const ids = scopeOf(await requireUser());
  const q = z.string().trim().max(100).catch("").parse(query);
  const pattern = `%${q.replace(/[%_]/g, "")}%`;

  const [clientRows, agentRows, convRows] = await Promise.all([
    db
      .select({ id: clients.id, name: clients.name, industry: clients.industry, color: clients.color })
      .from(clients)
      .where(and(q ? like(clients.name, pattern) : undefined, inScope(clients.id, ids)))
      .limit(q ? 6 : 8),
    db
      .select({ id: agents.id, name: agents.name, config: agents.config, client: clients.name })
      .from(agents)
      .innerJoin(clients, eq(clients.id, agents.clientId))
      .where(and(q ? or(like(agents.name, pattern), like(clients.name, pattern)) : undefined, inScope(agents.clientId, ids)))
      .limit(q ? 6 : 8),
    db
      .select({
        id: conversations.id,
        name: conversations.contactName,
        handle: conversations.contactHandle,
        text: conversations.lastMessageText,
        client: clients.name,
        color: clients.color,
      })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(and(q ? or(like(conversations.contactName, pattern), like(conversations.contactHandle, pattern), like(conversations.lastMessageText, pattern)) : undefined, inScope(conversations.clientId, ids)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(q ? 8 : 5),
  ]);

  return [
    ...clientRows.map((c): SearchHit => ({ kind: "client", id: c.id, title: c.name, subtitle: c.industry ?? "", color: c.color })),
    ...agentRows.map((a): SearchHit => ({ kind: "agent", id: a.id, title: a.name, subtitle: a.client, icon: (a.config as AgentConfig).icon || "🤖" })),
    ...convRows.map((c): SearchHit => ({
      kind: "conversation",
      id: c.id,
      title: c.name || c.handle || "—",
      subtitle: `${c.client} · ${c.text.slice(0, 80)}`,
      color: c.color,
    })),
  ];
}
