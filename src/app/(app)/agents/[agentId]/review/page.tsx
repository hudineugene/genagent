import { notFound } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients } from "@/db/schema";
import { getAgentReview } from "@/lib/agent/review";
import { getT } from "@/lib/i18n/server";
import { BackLink } from "@/components/back-link";
import { AgentTabs } from "../tabs";
import { ReviewManager } from "./manager";

export default async function AgentReviewPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const { t } = await getT();
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();

  const [[{ n: channelCount }], review] = await Promise.all([
    db.select({ n: count() }).from(channels).where(eq(channels.agentId, agentId)),
    getAgentReview(agentId),
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
      <AgentTabs agentId={agentId} active="review" channels={channelCount} t={t} />
      <ReviewManager agentId={agentId} review={review ?? null} />
    </div>
  );
}

export const instant = false;
