"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { testScenarios } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { generateScenarios, scenarioFromConversation, startRun } from "@/lib/tests/engine";

export type TestsResult = { error?: string; ok?: boolean; runId?: string; count?: number };

const errorCode = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function generateTestScenarios(agentId: string): Promise<TestsResult> {
  await requireUser();
  try {
    const count = await generateScenarios(agentId);
    refresh();
    return { ok: true, count };
  } catch (e) {
    console.error("generate scenarios failed", e);
    return { error: errorCode(e) };
  }
}

/** «В автотест» из «Диалогов»: сценарий-повтор реальной ошибки агента. */
export async function scenarioFromConversationAction(conversationId: string): Promise<TestsResult & { agentId?: string; name?: string }> {
  await requireUser();
  try {
    const r = await scenarioFromConversation(conversationId);
    refresh();
    return { ok: true, agentId: r.agentId, name: r.name };
  } catch (e) {
    console.error("scenario from conversation failed", e);
    return { error: errorCode(e) };
  }
}

const scenarioSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["script", "simulate"]),
  turns: z.array(z.string().trim().max(2000)).max(8),
  persona: z.string().trim().max(2000),
  maxTurns: z.number().int().min(1).max(6),
  criteria: z.array(z.string().trim().min(1).max(500)).max(8),
});

export async function saveScenario(
  agentId: string,
  id: string | null,
  input: z.input<typeof scenarioSchema>,
): Promise<TestsResult> {
  await requireUser();
  const parsed = scenarioSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const turns = d.turns.filter(Boolean);
  if (d.mode === "script" && !turns.length) return { error: "no_turns" };
  if (d.mode === "simulate" && !d.persona) return { error: "no_persona" };
  const values = {
    name: d.name,
    mode: d.mode,
    turns: d.mode === "script" ? turns : [],
    persona: d.mode === "simulate" ? d.persona : "",
    maxTurns: d.maxTurns,
    criteria: d.criteria.map((text) => ({ text })),
  };
  if (id) {
    await db.update(testScenarios).set(values).where(and(eq(testScenarios.id, id), eq(testScenarios.agentId, agentId)));
  } else {
    await db.insert(testScenarios).values({ agentId, ...values });
  }
  refresh();
  return { ok: true };
}

export async function deleteScenario(id: string): Promise<TestsResult> {
  await requireUser();
  await db.delete(testScenarios).where(eq(testScenarios.id, id));
  refresh();
  return { ok: true };
}

export async function runTests(agentId: string): Promise<TestsResult> {
  const user = await requireUser();
  try {
    const runId = await startRun(agentId, user.id);
    refresh();
    return { ok: true, runId };
  } catch (e) {
    return { error: errorCode(e) };
  }
}
