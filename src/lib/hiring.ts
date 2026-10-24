import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { candidates, vacancies } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";

/**
 * Отбор резюме: каждое резюме сверяется с требованиями вакансии — балл 0–100, вывод (подходит / под вопросом /
 * не подходит), сильные стороны и чего не хватает с опорой на текст резюме. Список сортируется по баллу.
 */
const MODEL = "claude-sonnet-5-5";
const RESUME_CHARS = 30_000;
const CONCURRENCY = 3;

type Scored = { name: string; contact: string; score: number; verdict: "strong" | "maybe" | "no"; summary: string; strengths: string[]; gaps: string[] };

async function scoreOne(id: string) {
  const [c] = await db.select().from(candidates).where(eq(candidates.id, id));
  if (!c) return;
  const [v] = await db.select().from(vacancies).where(eq(vacancies.id, c.vacancyId));
  try {
    const key = apiKey("anthropic");
    if (!key) throw new Error("no_key");
    if (!v?.requirements.trim()) throw new Error("no_requirements");
    const started = Date.now();
    const { data, usage, model } = await generateJson<Scored>(key, MODEL, {
      system: [
        `Ты рекрутер. Вакансия: «${v.title}». Требования:\n${v.requirements}`,
        "Сверь резюме с требованиями: опыт (лет и где), навыки, квалификация, обязательные условия. Обязательное требование не выполнено — балл не выше 40.",
        "score — 0–100 (соответствие требованиям). verdict: strong (≥75, звать на интервью), maybe (45–74), no (<45).",
        "summary — 1–2 предложения: почему такой балл. strengths и gaps — по 1–5 коротких пунктов, только по фактам из резюме (не выдумывай). Пиши по-русски.",
        "name — имя кандидата из резюме (иначе пусто), contact — почта или телефон из резюме (иначе пусто).",
        "Не учитывай пол, возраст, национальность, семейное положение, фото — только профессиональное соответствие.",
      ].join("\n"),
      prompt: `Резюме (${c.filename || "текст"}):\n${c.text.slice(0, RESUME_CHARS)}`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "contact", "score", "verdict", "summary", "strengths", "gaps"],
        properties: {
          name: { type: "string" },
          contact: { type: "string" },
          score: { type: "integer" },
          verdict: { type: "string", enum: ["strong", "maybe", "no"] },
          summary: { type: "string" },
          strengths: { type: "array", items: { type: "string" } },
          gaps: { type: "array", items: { type: "string" } },
        },
      },
      effort: "low",
    });
    await logUsage({ source: "insights", model, usage, clientId: c.clientId, ms: Date.now() - started }).catch(() => {});
    const score = Math.min(100, Math.max(0, Math.round(data.score)));
    const verdict = score >= 75 ? "strong" : score >= 45 ? "maybe" : "no";
    await db
      .update(candidates)
      .set({
        name: c.name || data.name.trim().slice(0, 120),
        contact: c.contact || data.contact.trim().slice(0, 120),
        score,
        verdict,
        summary: data.summary.trim().slice(0, 600),
        strengths: data.strengths.map((s) => s.trim().slice(0, 200)).filter(Boolean).slice(0, 5),
        gaps: data.gaps.map((s) => s.trim().slice(0, 200)).filter(Boolean).slice(0, 5),
        status: "done",
        error: null,
      })
      .where(eq(candidates.id, id));
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    if (!["no_key", "no_requirements"].includes(code)) console.error("candidate scoring failed", id, e);
    await db.update(candidates).set({ status: "error", error: code.slice(0, 300) }).where(eq(candidates.id, id));
  }
}

/** Оценить кандидатов (в фоне, по 3 одновременно). */
export async function scoreCandidates(clientId: string, ids: string[]) {
  return withKeys({ clientId }, async () => {
    let i = 0;
    const work = async () => {
      while (i < ids.length) await scoreOne(ids[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, work));
  });
}

/** Добавить резюме к вакансии и оценить. */
export async function addCandidates(vacancyId: string, files: { filename: string; text: string }[]) {
  const [v] = await db.select().from(vacancies).where(eq(vacancies.id, vacancyId));
  if (!v) throw new Error("not_found");
  const rows = files.length
    ? await db
        .insert(candidates)
        .values(files.map((f) => ({ vacancyId, clientId: v.clientId, filename: f.filename.slice(0, 200), text: f.text.slice(0, RESUME_CHARS) })))
        .returning({ id: candidates.id })
    : [];
  void scoreCandidates(v.clientId, rows.map((r) => r.id));
  return rows.length;
}
