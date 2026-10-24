"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { knowledgeGaps } from "@/db/schema";
import { analyzeGaps } from "@/lib/agent/gaps";
import { addAnswerToKb } from "@/lib/agent/kb-answers";

import { requireOwned } from "@/lib/access";
export type GapResult = { ok?: boolean; error?: string; found?: number };

/** Добавить ответ: вопрос и ответ попадают в базу знаний клиента, вопрос закрывается. */
export async function resolveGap(gapId: string, answer: string): Promise<GapResult> {
  const user = await requireOwned("gap", gapId);
  const text = z.string().trim().min(2).max(4000).safeParse(answer);
  if (!text.success) return { error: "answer_short" };
  const r = await addAnswerToKb(gapId, text.data, user.id);
  if (r.error) return { error: r.error };
  refresh();
  return { ok: true };
}

export async function setGapStatus(gapId: string, status: "open" | "ignored"): Promise<GapResult> {
  await requireOwned("gap", gapId);
  await db.update(knowledgeGaps).set({ status }).where(eq(knowledgeGaps.id, gapId));
  refresh();
  return { ok: true };
}

/** «Проверить сейчас»: разобрать новые переписки агента, не дожидаясь ночной проверки. */
export async function analyzeGapsNow(agentId: string): Promise<GapResult> {
  await requireOwned("agent", agentId);
  try {
    const r = await analyzeGaps(agentId);
    refresh();
    return { ok: true, found: r.newGaps + r.updated };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
