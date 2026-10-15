import { notFound } from "next/navigation";
import { count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, knowledgeGaps } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { BackLink } from "@/components/back-link";
import { AgentTabs } from "../tabs";
import { GapsManager } from "./manager";

export default async function AgentGapsPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const { t } = await getT();
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();

  const [[{ n: channelCount }], gaps] = await Promise.all([
    db.select({ n: count() }).from(channels).where(eq(channels.agentId, agentId)),
    db.select().from(knowledgeGaps).where(eq(knowledgeGaps.agentId, agentId)).orderBy(desc(knowledgeGaps.count), desc(knowledgeGaps.lastSeenAt)),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink href={`/clients/${row.clientId}`} label={row.clientName} />
      <div className="mb-6 flex items-center gap-3">
        <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-2xl">
          {(row.agent.config as { icon?: string }).icon ?? "🤖"}
        </span>
        <h1 className="text-xl font-semibold">{row.agent.name}</h1>
      </div>
      <AgentTabs agentId={agentId} active="gaps" channels={channelCount} gaps={gaps.filter((g) => g.status === "open").length} t={t} />
      <GapsManager
        agentId={agentId}
        clientId={row.clientId}
        gaps={gaps.map((g) => ({
          id: g.id,
          question: g.question,
          missing: g.missing,
          count: g.count,
          status: g.status,
          answer: g.answer,
          lastSeenAt: g.lastSeenAt.getTime(),
          examples: g.examples,
        }))}
      />
    </div>
  );
}

export const instant = false;
