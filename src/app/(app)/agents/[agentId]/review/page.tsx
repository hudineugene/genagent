import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients } from "@/db/schema";
import { getAgentReview } from "@/lib/agent/review";
import { ReviewManager } from "./manager";

export default async function AgentReviewPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();

  const review = await getAgentReview(agentId);

  return (
    <div className="max-w-4xl">
      <ReviewManager agentId={agentId} review={review ?? null} />
    </div>
  );
}

export const instant = false;
