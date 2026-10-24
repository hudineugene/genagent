"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { courses, lessons } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { withKeys } from "@/lib/keys";

const courseSchema = z.object({
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().max(2000),
  level: z.enum(["beginner", "intermediate", "advanced"]),
  topics: z.string().trim().max(500),
  points: z.number().int().min(0).max(100_000),
  programId: z.string().max(64).nullable(),
  enabled: z.boolean(),
  position: z.number().int().min(0).max(1000),
});

export async function saveCourse(clientId: string, id: string | null, input: z.input<typeof courseSchema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = courseSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const values = { ...parsed.data, programId: parsed.data.programId || null, updatedAt: new Date() };
  if (id) {
    await db.update(courses).set(values).where(and(eq(courses.id, id), eq(courses.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(courses).values({ clientId, ...values }).returning({ id: courses.id });
  refresh();
  return { id: row.id };
}

export async function deleteCourse(id: string) {
  await requireUser();
  await db.delete(courses).where(eq(courses.id, id));
  refresh();
}

const lessonSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(20_000),
  videoUrl: z.string().trim().max(1000),
  quiz: z.array(z.object({ q: z.string().trim().min(1).max(500), options: z.array(z.string().trim().min(1).max(300)).min(2).max(6), correct: z.number().int().min(0).max(5) })).max(20),
  passScore: z.number().int().min(0).max(100),
  points: z.number().int().min(0).max(100_000),
  position: z.number().int().min(0).max(1000),
});

export async function saveLesson(courseId: string, id: string | null, input: z.input<typeof lessonSchema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = lessonSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "quiz") ? "quiz" : "invalid" };
  if (parsed.data.quiz.some((q) => q.correct >= q.options.length)) return { error: "quiz" };
  if (parsed.data.videoUrl && !/^https?:\/\//i.test(parsed.data.videoUrl)) return { error: "video" };
  if (id) {
    await db.update(lessons).set(parsed.data).where(and(eq(lessons.id, id), eq(lessons.courseId, courseId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(lessons).values({ courseId, ...parsed.data }).returning({ id: lessons.id });
  refresh();
  return { id: row.id };
}

export async function deleteLesson(id: string) {
  await requireUser();
  await db.delete(lessons).where(eq(lessons.id, id));
  refresh();
}

/** Тест к уроку по его тексту (ИИ, в области ключей клиента). */
export async function generateQuizAction(clientId: string, body: string) {
  await requireUser();
  if (body.trim().length < 50) return { error: "short" as const };
  try {
    const { generateQuiz } = await import("@/lib/learning");
    return { quiz: await withKeys({ clientId }, () => generateQuiz(clientId, body)) };
  } catch (e) {
    return { error: (e instanceof Error && e.message === "no_key" ? "no_key" : "failed") as "no_key" | "failed" };
  }
}
