import "server-only";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channels, conversations, courses, learners, lessons, loyaltyPrograms, type Course, type Learner, type Lesson, type QuizQuestion } from "@/db/schema";
import type { ToolContext } from "@/lib/agent/tools";
import type { AgentTool } from "@/lib/llm";
import { generateJson } from "@/lib/llm/anthropic";
import { apiKey } from "@/lib/keys";
import { logUsage } from "@/lib/usage";

/**
 * Обучение в мессенджере: курсы из уроков (текст, видео, тест). Агент ведёт ученика: подбирает личную программу
 * по уровню, цели и пройденному, выдаёт следующий урок, проверяет тест (проверяет код), начисляет баллы за уроки
 * и курс в программу баллов клиента, объясняет, на что их потратить; молчит 3 дня — напоминаем продолжить.
 */
const LEVELS = ["beginner", "intermediate", "advanced"] as const;
const REMIND_AFTER_MS = 3 * 86400_000;
const LESSON_CHARS = 6000;

const norm = (s: string) => s.trim().replace(/^@/, "").toLowerCase();

async function loadCourses(clientId: string) {
  const list = await db.select().from(courses).where(and(eq(courses.clientId, clientId), eq(courses.enabled, true))).orderBy(asc(courses.position), asc(courses.createdAt));
  const ls = list.length ? await db.select().from(lessons).where(inArray(lessons.courseId, list.map((c) => c.id))).orderBy(asc(lessons.position), asc(lessons.createdAt)) : [];
  return list.map((c) => ({ course: c, lessons: ls.filter((l) => l.courseId === c.id) }));
}
type CourseWithLessons = Awaited<ReturnType<typeof loadCourses>>[number];

export async function hasCourses(clientId: string) {
  const [x] = await db.select({ id: courses.id }).from(courses).where(and(eq(courses.clientId, clientId), eq(courses.enabled, true))).limit(1);
  return Boolean(x);
}

/** Ученик по разговору (по @нику или id чата). */
async function learnerFor(clientId: string, conversationId: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!c) return null;
  const contact = norm(c.contactHandle) || norm(c.externalId);
  const [found] = await db.select().from(learners).where(and(eq(learners.clientId, clientId), eq(learners.contact, contact)));
  if (found) {
    if (found.conversationId !== c.id) await db.update(learners).set({ conversationId: c.id }).where(eq(learners.id, found.id));
    return found;
  }
  const [row] = await db.insert(learners).values({ clientId, contact, name: c.contactName, conversationId: c.id }).onConflictDoNothing().returning();
  return row ?? (await db.select().from(learners).where(and(eq(learners.clientId, clientId), eq(learners.contact, contact))))[0];
}

const passedCount = (l: Learner, cw: CourseWithLessons) => cw.lessons.filter((x) => l.results[x.id]?.passed).length;
const courseDone = (l: Learner, cw: CourseWithLessons) => cw.lessons.length > 0 && passedCount(l, cw) === cw.lessons.length;

/** Личная программа: курсы под цель (совпадение тем и названий), от уровня ученика и выше, без уже пройденных. */
export function buildPath(all: CourseWithLessons[], l: Pick<Learner, "results">, goal: string, level: string) {
  const words = goal
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const from = Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]));
  const scored = all
    .filter((cw) => !courseDone(l as Learner, cw) && LEVELS.indexOf(cw.course.level) >= from)
    .map((cw) => {
      const text = `${cw.course.title} ${cw.course.topics} ${cw.course.description}`.toLowerCase();
      return { cw, score: words.filter((w) => text.includes(w.slice(0, Math.max(4, w.length - 2)))).length };
    });
  const relevant = words.length && scored.some((x) => x.score > 0) ? scored.filter((x) => x.score > 0) : scored;
  return relevant
    .sort((a, b) => LEVELS.indexOf(a.cw.course.level) - LEVELS.indexOf(b.cw.course.level) || b.score - a.score || a.cw.course.position - b.cw.course.position)
    .map((x) => x.cw.course.id);
}

/** Следующий урок: по программе (или в заданном курсе) — первый не сданный. */
export function nextLesson(all: CourseWithLessons[], l: Pick<Learner, "results" | "path">, courseId?: string) {
  const order = courseId ? [courseId] : [...l.path, ...all.map((x) => x.course.id).filter((id) => !l.path.includes(id))];
  for (const id of order) {
    const cw = all.find((x) => x.course.id === id);
    const lesson = cw?.lessons.find((x) => !l.results[x.id]?.passed);
    if (cw && lesson) return { cw, lesson, index: cw.lessons.indexOf(lesson) };
  }
  return null;
}

/** Проверка теста: ответы — номера вариантов с 1. */
export function grade(quiz: QuizQuestion[], answers: number[]) {
  const wrong: number[] = [];
  quiz.forEach((q, i) => {
    if (answers[i] - 1 !== q.correct) wrong.push(i);
  });
  return { score: quiz.length ? Math.round(((quiz.length - wrong.length) / quiz.length) * 100) : 100, wrong };
}

async function award(clientId: string, programId: string | null, conversationId: string | null, points: number, reason: string) {
  if (!points || !programId) return false;
  const [p] = await db.select().from(loyaltyPrograms).where(and(eq(loyaltyPrograms.id, programId), eq(loyaltyPrograms.clientId, clientId)));
  if (!p || !conversationId) return false;
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!c) return false;
  const { addPoints, conversationKeys, ensureAccount } = await import("@/lib/loyalty/engine");
  const { account } = await ensureAccount(p, conversationKeys(c), { name: c.contactName, conversationId: c.id });
  return Boolean(await addPoints(account, points, reason, "agent"));
}

const lessonText = (cw: CourseWithLessons, lesson: Lesson, index: number) =>
  [
    `Course «${cw.course.title}», lesson ${index + 1} of ${cw.lessons.length}: «${lesson.title}» (lesson_id: ${lesson.id})`,
    lesson.body.slice(0, LESSON_CHARS),
    lesson.videoUrl ? `Video: ${lesson.videoUrl}` : "",
    lesson.quiz.length
      ? `Quiz (ask after the learner has read the lesson; they answer with option numbers):\n${lesson.quiz.map((q, i) => `${i + 1}. ${q.q}\n${q.options.map((o, j) => `   ${j + 1}) ${o}`).join("\n")}`).join("\n")}`
      : "No quiz — after reading, call learning_answer with an empty answers list to mark the lesson as done.",
  ]
    .filter(Boolean)
    .join("\n\n");

export const learningNote =
  "# Обучение\nТы ведёшь ученика по курсам компании прямо в чате. Сначала узнай цель и уровень и составь программу (learning_plan), затем выдавай уроки по одному (learning_next): перескажи урок коротко своими словами, дай ссылку на видео, потом задай вопросы теста. Ответы проверяет только learning_answer — не оценивай сам. Говори о баллах и прогрессе по learning_progress. Вопрос по материалу, на который нет ответа в уроке и базе знаний, или просьба поговорить с преподавателем — передай преподавателю (как передачу менеджеру, причина: «вопрос преподавателю: …»).";

export function learningTools(ctx: ToolContext & { clientId: string }): AgentTool[] {
  const me = async () => (ctx.conversationId && ctx.mode === "live" ? learnerFor(ctx.clientId, ctx.conversationId) : null);
  const touch = (id: string, patch: Partial<Learner> = {}) => db.update(learners).set({ ...patch, lastActivityAt: new Date() }).where(eq(learners.id, id));
  return [
    {
      name: "learning_plan",
      description: "Build a personal learning path for the learner from the company's courses based on their goal and level (beginner / intermediate / advanced). Already completed courses are skipped. Use at the start or when the goal changes.",
      inputSchema: {
        type: "object",
        properties: { goal: { type: "string", description: "What the learner wants to achieve, in their words" }, level: { type: "string", enum: [...LEVELS] } },
        required: ["goal", "level"],
      },
      parse: z.object({ goal: z.string().trim().max(500), level: z.enum(LEVELS) }),
      run: async (input) => {
        const x = input as { goal: string; level: string };
        const all = await loadCourses(ctx.clientId);
        if (!all.length) return "No courses are available yet.";
        const l = await me();
        const path = buildPath(all, l ?? { results: {} }, x.goal, x.level);
        if (l) await touch(l.id, { goal: x.goal.slice(0, 500), level: x.level, path });
        const names = path.map((id, i) => {
          const cw = all.find((c) => c.course.id === id)!;
          return `${i + 1}. ${cw.course.title} (${cw.course.level}, ${cw.lessons.length} lessons${cw.course.points ? `, +${cw.course.points} points for completion` : ""})`;
        });
        return names.length ? `Personal path:\n${names.join("\n")}` : "All matching courses are already completed.";
      },
    },
    {
      name: "learning_next",
      description: "Get the next lesson for the learner (by their path, or in a given course): lesson text, video link and quiz questions.",
      inputSchema: { type: "object", properties: { course: { type: "string", description: "Course title (optional)" } } },
      parse: z.object({ course: z.string().max(200).optional() }),
      run: async (input) => {
        const all = await loadCourses(ctx.clientId);
        if (!all.length) return "No courses are available yet.";
        const name = (input as { course?: string }).course?.toLowerCase().trim();
        const courseId = name ? all.find((c) => c.course.title.toLowerCase().includes(name))?.course.id : undefined;
        const l = await me();
        const n = nextLesson(all, l ?? { results: {}, path: [] }, courseId);
        if (!n) return "All lessons are completed. Congratulate the learner.";
        if (l) await touch(l.id);
        return lessonText(n.cw, n.lesson, n.index);
      },
    },
    {
      name: "learning_answer",
      description: "Check the learner's quiz answers for a lesson (option numbers starting from 1, in question order). Returns the score, which questions are wrong, points earned and what is next.",
      inputSchema: {
        type: "object",
        properties: { lesson_id: { type: "string" }, answers: { type: "array", items: { type: "integer" } } },
        required: ["lesson_id", "answers"],
      },
      parse: z.object({ lesson_id: z.string().min(1).max(64), answers: z.array(z.number().int().min(0).max(20)).max(50) }),
      run: async (input) => {
        const x = input as { lesson_id: string; answers: number[] };
        const [lesson] = await db.select().from(lessons).where(eq(lessons.id, x.lesson_id));
        const [course] = lesson ? await db.select().from(courses).where(and(eq(courses.id, lesson.courseId), eq(courses.clientId, ctx.clientId))) : [];
        if (!lesson || !course) return "Unknown lesson.";
        const g = grade(lesson.quiz, x.answers);
        const passed = g.score >= lesson.passScore;
        if (ctx.mode !== "live") return `[Test mode] Score ${g.score}%, ${passed ? "passed" : `wrong: ${g.wrong.map((i) => i + 1).join(", ")}`}`;
        const l = await me();
        if (!l) return `Score ${g.score}%.`;
        const prev = l.results[lesson.id];
        const results = { ...l.results, [lesson.id]: { score: Math.max(g.score, prev?.score ?? 0), passed: passed || Boolean(prev?.passed), at: Date.now(), tries: (prev?.tries ?? 0) + 1 } };
        let earned = 0;
        const notes: string[] = [];
        if (passed && !prev?.passed && lesson.points) {
          earned += lesson.points;
          await award(ctx.clientId, course.programId, l.conversationId, lesson.points, `Обучение: урок «${lesson.title}»`);
        }
        const all = await loadCourses(ctx.clientId);
        const cw = all.find((c) => c.course.id === course.id);
        const updated = { ...l, results };
        if (passed && !prev?.passed && cw && courseDone(updated, cw) && course.points) {
          earned += course.points;
          await award(ctx.clientId, course.programId, l.conversationId, course.points, `Обучение: курс «${course.title}» пройден`);
          notes.push(`Course «${course.title}» completed — congratulate and give a short certificate line with the date.`);
        }
        await touch(l.id, { results, points: l.points + earned });
        if (!passed) {
          const tries = results[lesson.id].tries;
          notes.push(
            tries >= 2
              ? `Wrong: ${g.wrong.map((i) => `${i + 1} (correct: ${lesson.quiz[i].options[lesson.quiz[i].correct]})`).join("; ")}. Explain the correct answers using the lesson text, then they may retry.`
              : `Wrong questions: ${g.wrong.map((i) => i + 1).join(", ")}. Point to the relevant part of the lesson without giving the answers and let them retry.`,
          );
        }
        const n = nextLesson(all, updated);
        return [
          `Score ${g.score}% (pass ${lesson.passScore}%): ${passed ? "passed" : "not passed"}.`,
          earned ? `Points earned: ${earned}. Total learning points: ${l.points + earned}.` : "",
          ...notes,
          passed ? (n ? `Next: «${n.lesson.title}» in «${n.cw.course.title}».` : "All lessons in the path are done.") : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "learning_progress",
      description: "Learner's progress: courses with passed lessons, points earned for learning and how points can be used (rewards of the loyalty program).",
      inputSchema: { type: "object", properties: {} },
      parse: z.object({}).passthrough(),
      run: async () => {
        const all = await loadCourses(ctx.clientId);
        const l = await me();
        if (!l) return all.map((c) => `${c.course.title}: 0/${c.lessons.length}`).join("\n") || "No courses.";
        const programIds = [...new Set(all.map((c) => c.course.programId).filter((x): x is string => Boolean(x)))];
        const progs = programIds.length ? await db.select().from(loyaltyPrograms).where(inArray(loyaltyPrograms.id, programIds)) : [];
        return [
          ...all.map((c) => `${c.course.title}: ${passedCount(l, c)}/${c.lessons.length}${courseDone(l, c) ? " ✅" : ""}`),
          `Learning points: ${l.points}.`,
          ...progs.map((p) => `Points go to «${p.name}». Rewards: ${p.rewards.map((r) => `${r.name} — ${r.cost}`).join("; ") || "—"} (exchange via loyalty_redeem if enabled).`),
          l.goal ? `Goal: ${l.goal}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
  ];
}

/** Тест к уроку из его текста (ИИ): 3–5 вопросов с вариантами. */
export async function generateQuiz(clientId: string, body: string, n = 4): Promise<QuizQuestion[]> {
  const key = apiKey("anthropic");
  if (!key) throw new Error("no_key");
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ quiz: QuizQuestion[] }>(key, "claude-haiku-5-5", {
    system: `Составь ${n} вопроса теста по тексту урока: только по фактам из текста, 3–4 варианта ответа, один правильный (correct — индекс с 0), без «все перечисленные». Язык — язык урока.`,
    prompt: body.slice(0, 20_000),
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["quiz"],
      properties: {
        quiz: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["q", "options", "correct"], properties: { q: { type: "string" }, options: { type: "array", items: { type: "string" } }, correct: { type: "integer" } } },
        },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "generate", model, usage, clientId, ms: Date.now() - started }).catch(() => {});
  return data.quiz.filter((q) => q.q.trim() && q.options.length >= 2 && q.correct >= 0 && q.correct < q.options.length).slice(0, 10);
}

/** Раз в 10 минут (днём): кто начал и молчит 3 дня — напомнить следующий урок (не чаще раза в 3 дня). */
export async function learningTick(now = new Date()) {
  const { quietUntil } = await import("@/lib/campaigns/engine");
  if (quietUntil(now)) return 0;
  const edge = new Date(now.getTime() - REMIND_AFTER_MS);
  const list = await db
    .select()
    .from(learners)
    .where(and(lt(learners.lastActivityAt, edge), or(isNull(learners.remindedAt), lt(learners.remindedAt, edge))));
  let n = 0;
  const { addMessage, deliver } = await import("@/lib/conversations");
  for (const l of list) {
    if (!l.conversationId || !Object.keys(l.results).length) continue;
    const all = await loadCourses(l.clientId);
    const next = nextLesson(all, l);
    await db.update(learners).set({ remindedAt: now }).where(eq(learners.id, l.id));
    if (!next) continue;
    const [r] = await db.select({ conv: conversations, channel: channels }).from(conversations).innerJoin(channels, eq(channels.id, conversations.channelId)).where(eq(conversations.id, l.conversationId));
    if (!r || r.conv.context?.optOut || !r.channel.enabled) continue;
    const text = `📚 ${l.name ? `${l.name}, ` : ""}продолжим обучение? Следующий урок — «${next.lesson.title}» (курс «${next.cw.course.title}»). Напишите «дальше», когда будет минутка.`;
    try {
      const externalId = await deliver(r.channel, r.conv, text);
      await addMessage(r.conv.id, "assistant", text, { externalId: externalId ?? undefined });
      n++;
    } catch (e) {
      console.error("learning reminder failed", e);
    }
  }
  return n;
}

/** Аналитика обучения: по курсам — сколько начали и закончили, средний балл, где застревают; активность учеников. */
export async function learningStats(clientId: string, now = Date.now()) {
  const all = await loadCourses(clientId);
  const people = await db.select().from(learners).where(eq(learners.clientId, clientId));
  const active7 = people.filter((p) => p.lastActivityAt && now - p.lastActivityAt.getTime() < 7 * 86400_000).length;
  const perCourse = all.map((cw) => {
    const ids = new Set(cw.lessons.map((x) => x.id));
    const started = people.filter((p) => Object.keys(p.results).some((k) => ids.has(k)));
    const finished = started.filter((p) => courseDone(p, cw));
    const scores = started.flatMap((p) => cw.lessons.map((x) => p.results[x.id]?.score).filter((s): s is number => typeof s === "number"));
    // Где застревают: урок с наибольшей долей несданных попыток
    const hardest = cw.lessons
      .map((x) => {
        const tried = started.filter((p) => p.results[x.id]);
        const failed = tried.filter((p) => !p.results[x.id].passed || p.results[x.id].tries > 1).length;
        return { title: x.title, rate: tried.length ? failed / tried.length : 0, tried: tried.length };
      })
      .filter((x) => x.tried > 0 && x.rate > 0)
      .sort((a, b) => b.rate - a.rate)[0];
    return {
      id: cw.course.id,
      title: cw.course.title,
      started: started.length,
      finished: finished.length,
      avgScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
      hardest: hardest ? { title: hardest.title, pct: Math.round(hardest.rate * 100) } : null,
    };
  });
  return { learners: people.length, active7, points: people.reduce((s, p) => s + p.points, 0), courses: perCourse };
}

export type { Course };
