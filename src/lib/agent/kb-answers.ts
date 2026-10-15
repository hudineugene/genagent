import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, kbSources, knowledgeGaps } from "@/db/schema";
import { indexSource } from "@/lib/kb/store";
import { normalizeText } from "@/lib/kb/text";

/** Ответы на вопросы без ответа копятся в одном текстовом источнике базы знаний клиента. */
export const ANSWERS_TITLE = "Ответы на частые вопросы";

/**
 * Добавить ответ в базу знаний: «Вопрос/Ответ» дописывается в источник «Ответы на частые вопросы», вопрос закрывается.
 * Агенты клиента с явным списком источников получают новый источник в свой список — иначе ответа они бы не видели.
 */
export async function addAnswerToKb(gapId: string, answer: string, userId?: string | null): Promise<{ ok?: boolean; error?: string }> {
  const text = answer.trim();
  if (text.length < 2 || text.length > 4000) return { error: "answer_short" };
  const [gap] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, gapId));
  if (!gap) return { error: "not_found" };
  if (gap.status === "resolved") return { error: "already" };

  const entry = `Вопрос: ${gap.question}\nОтвет: ${text}`;
  // Источник, созданный здесь, а не присланный ботом (у присланных есть external_key — их бот перезаписывает).
  const [source] = await db
    .select()
    .from(kbSources)
    .where(and(eq(kbSources.clientId, gap.clientId), eq(kbSources.title, ANSWERS_TITLE), isNull(kbSources.externalKey)));
  if (source) {
    indexSource(source.id, gap.clientId, ANSWERS_TITLE, normalizeText(`${source.content}\n\n${entry}`));
  } else {
    const [row] = await db
      .insert(kbSources)
      .values({ clientId: gap.clientId, type: "text", title: ANSWERS_TITLE, createdBy: userId ?? null })
      .returning({ id: kbSources.id });
    indexSource(row.id, gap.clientId, ANSWERS_TITLE, normalizeText(`# ${ANSWERS_TITLE}\n\n${entry}`));
    const list = await db.select({ id: agents.id, config: agents.config }).from(agents).where(eq(agents.clientId, gap.clientId));
    for (const a of list) {
      const ids = (a.config as { kbSourceIds?: string[] | null }).kbSourceIds;
      if (Array.isArray(ids) && !ids.includes(row.id)) {
        await db.update(agents).set({ config: { ...a.config, kbSourceIds: [...ids, row.id] } }).where(eq(agents.id, a.id));
      }
    }
  }
  await db.update(knowledgeGaps).set({ status: "resolved", answer: text }).where(eq(knowledgeGaps.id, gapId));
  return { ok: true };
}
