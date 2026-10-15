"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { applyProposalToConfig, getAgentReview, reviewAgent, saveAgentReview } from "@/lib/agent/review";
import type { AgentConfig } from "@/lib/agent/types";
import { saveAgent } from "./agents";

export type ReviewResult = { ok?: boolean; error?: string; tests?: boolean };

/** «Разобрать сейчас»: неделя агента — отчёт и предложения правок (один вызов дешёвой модели). */
export async function reviewAgentNow(agentId: string): Promise<ReviewResult> {
  await requireUser();
  try {
    const r = await reviewAgent(agentId);
    refresh();
    return r ? { ok: true } : { error: "too_few" };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** Принять правку: новая версия агента и автотесты в фоне (если у агента есть сценарии). */
export async function applyReviewProposal(agentId: string, proposalId: string): Promise<ReviewResult> {
  const user = await requireUser();
  const review = await getAgentReview(agentId);
  const p = review?.proposals.find((x) => x.id === proposalId);
  if (!review || !p || p.status !== "new") return { error: "not_found" };
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return { error: "not_found" };
  const next = applyProposalToConfig(agent.config as AgentConfig, p);
  if ("error" in next) return { error: next.error };
  await saveAgent(agentId, { name: agent.name, status: agent.status, config: next });
  p.status = "applied";
  await saveAgentReview(agentId, review);
  let tests = false;
  try {
    const { startRunTracked } = await import("@/lib/tests/engine");
    const { done } = await startRunTracked(agentId, user.id);
    void done.catch(() => {});
    tests = true;
  } catch {
    // нет сценариев или ключа — правка сохранена, проверка без автотестов
  }
  refresh();
  return { ok: true, tests };
}

export async function rejectReviewProposal(agentId: string, proposalId: string): Promise<ReviewResult> {
  await requireUser();
  const review = await getAgentReview(agentId);
  const p = review?.proposals.find((x) => x.id === proposalId);
  if (!review || !p) return { error: "not_found" };
  p.status = "rejected";
  await saveAgentReview(agentId, review);
  refresh();
  return { ok: true };
}
