import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, testResults, testRuns, testScenarios } from "@/db/schema";
import { TestsManager } from "./manager";

import { guardPage } from "@/lib/access";
export default async function AgentTestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const [{ agentId }, sp] = await Promise.all([params, searchParams]);
  await guardPage("agent", agentId);
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();
  const { agent } = row;

  const [scenarios, runs] = await Promise.all([
    db.select().from(testScenarios).where(eq(testScenarios.agentId, agentId)).orderBy(asc(testScenarios.createdAt)),
    db.select().from(testRuns).where(eq(testRuns.agentId, agentId)).orderBy(desc(testRuns.createdAt)).limit(20),
  ]);
  const selected = runs.find((r) => r.id === sp.run) ?? runs[0] ?? null;
  const results = selected
    ? await db.select().from(testResults).where(eq(testResults.runId, selected.id)).orderBy(asc(testResults.createdAt))
    : [];

  return (
    <div className="max-w-5xl">
      <TestsManager
        agentId={agent.id}
        agentVersion={agent.version}
        agentModel={agent.config.model}
        scenarios={scenarios.map((s) => ({
          id: s.id,
          name: s.name,
          mode: s.mode,
          turns: s.turns,
          persona: s.persona,
          maxTurns: s.maxTurns,
          criteria: s.criteria.map((c) => c.text),
        }))}
        runs={runs.map((r) => ({
          id: r.id,
          agentVersion: r.agentVersion,
          model: r.model,
          k: r.k,
          status: r.status,
          total: r.total,
          passed: r.passed,
          score: r.score,
          cost: r.cost,
          error: r.error,
          createdAt: r.createdAt,
        }))}
        selectedRunId={selected?.id ?? null}
        results={results.map((r) => ({
          id: r.id,
          scenarioName: r.scenarioName,
          transcript: r.transcript,
          verdicts: r.verdicts,
          score: r.score,
          passed: r.passed,
          summary: r.summary,
          error: r.error,
          cost: r.cost,
        }))}
      />
    </div>
  );
}

export const instant = false;
