"use server";

import { refresh } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { kbSources, knowledgeGaps } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { analyzeGaps } from "@/lib/agent/gaps";
import { indexSource } from "@/lib/kb/store";
import { normalizeText } from "@/lib/kb/text";

export type GapResult = { ok?: boolean; error?: string; found?: number };

/** Ответы на вопросы без ответа копятся в одном текстовом источнике базы знаний клиента. */
const ANSWERS_TITLE = "Ответы на частые вопросы";

/** Добавить ответ: вопрос и ответ попадают в базу знаний клиента, вопрос закрывается. */
export async function resolveGap(gapId: string, answer: string): Promise<GapResult> {
  const user = await requireUser();
  const text = z.string().trim().min(2).max(4000).safeParse(answer);
  if (!text.success) return { error: "answer_short" };
  const [gap] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, gapId));
  if (!gap) return { error: "not_found" };

  const entry = `Вопрос: ${gap.question}\nОтвет: ${text.data}`;
  // Источник, созданный здесь, а не присланный ботом (у присланных есть external_key — их бот перезаписывает).
  const [source] = await db
    .select()
    .from(kbSources)
    .where(and(eq(kbSources.clientId, gap.clientId), eq(kbSources.title, ANSWERS_TITLE), isNull(kbSources.externalKey)));
  if (source) {
    const content = normalizeText(`${source.content}\n\n${entry}`);
    indexSource(source.id, gap.clientId, ANSWERS_TITLE, content);
  } else {
    const [row] = await db
      .insert(kbSources)
      .values({ clientId: gap.clientId, type: "text", title: ANSWERS_TITLE, createdBy: user.id })
      .returning({ id: kbSources.id });
    indexSource(row.id, gap.clientId, ANSWERS_TITLE, normalizeText(`# ${ANSWERS_TITLE}\n\n${entry}`));
  }
  await db.update(knowledgeGaps).set({ status: "resolved", answer: text.data }).where(eq(knowledgeGaps.id, gapId));
  refresh();
  return { ok: true };
}

export async function setGapStatus(gapId: string, status: "open" | "ignored"): Promise<GapResult> {
  await requireUser();
  await db.update(knowledgeGaps).set({ status }).where(eq(knowledgeGaps.id, gapId));
  refresh();
  return { ok: true };
}

/** «Проверить сейчас»: разобрать новые переписки агента, не дожидаясь ночной проверки. */
export async function analyzeGapsNow(agentId: string): Promise<GapResult> {
  await requireUser();
  try {
    const r = await analyzeGaps(agentId);
    refresh();
    return { ok: true, found: r.newGaps + r.updated };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
