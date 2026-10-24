"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { candidates, vacancies } from "@/db/schema";
import { requireUser } from "@/lib/auth";

const schema = z.object({ title: z.string().trim().min(1).max(150), requirements: z.string().trim().min(10).max(6000) });

export async function saveVacancy(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const values = { ...parsed.data, updatedAt: new Date() };
  if (id) {
    await db.update(vacancies).set(values).where(and(eq(vacancies.id, id), eq(vacancies.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(vacancies).values({ clientId, ...values }).returning({ id: vacancies.id });
  refresh();
  return { id: row.id };
}

export async function deleteVacancy(id: string) {
  await requireUser();
  await db.delete(vacancies).where(eq(vacancies.id, id));
  refresh();
}

/** Резюме текстом (из письма, сайта). */
export async function addResumeText(vacancyId: string, text: string): Promise<{ error?: string }> {
  await requireUser();
  if (text.trim().length < 50) return { error: "short" };
  const { addCandidates } = await import("@/lib/hiring");
  await addCandidates(vacancyId, [{ filename: "", text: text.trim() }]);
  refresh();
  return {};
}

/** Оценить всех кандидатов заново (после правки требований). */
export async function rescoreVacancy(vacancyId: string) {
  await requireUser();
  const [v] = await db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
  if (!v) return;
  const list = await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.vacancyId, vacancyId));
  await db.update(candidates).set({ status: "processing", error: null }).where(eq(candidates.vacancyId, vacancyId));
  const { scoreCandidates } = await import("@/lib/hiring");
  void scoreCandidates(v.clientId, list.map((x) => x.id));
  refresh();
}

export async function deleteCandidate(id: string) {
  await requireUser();
  await db.delete(candidates).where(eq(candidates.id, id));
  refresh();
}
