import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, knowledgeGaps } from "@/db/schema";
import { GapsManager } from "./manager";

export default async function AgentGapsPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();

  const gaps = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.agentId, agentId)).orderBy(desc(knowledgeGaps.count), desc(knowledgeGaps.lastSeenAt));

  return (
    <div className="max-w-4xl">
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
          suggestion: g.suggestion,
          lastSeenAt: g.lastSeenAt.getTime(),
          examples: g.examples,
        }))}
      />
    </div>
  );
}

export const instant = false;
