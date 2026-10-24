import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, knowledgeGaps } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { loadKnowledge } from "@/lib/kb/store";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Вопросы без ответа устаревают: в базу знаний добавили документ — агент уже может ответить, а вопрос висит
 * и уходит владельцу. Сверяем открытые вопросы с текущими знаниями агента (тем же поиском, что при ответе клиенту);
 * если ответ там уже есть — закрываем вопрос с пометкой, откуда ответ. Дешёвая модель, один запрос на агента.
 */
const MODEL = "claude-haiku-5-5";
const MAX_GAPS = 30;
const MAX_CHARS = 60_000;

type Verdict = { id: string; answered: boolean; answer: string };

/** Сверить открытые вопросы агента. Возвращает, сколько закрыто. */
async function recheckGaps__(agentId: string): Promise<number> {
  const key = apiKey("anthropic");
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!key || !agent) return 0;
  const open = await db
    .select({ id: knowledgeGaps.id, question: knowledgeGaps.question })
    .from(knowledgeGaps)
    .where(and(eq(knowledgeGaps.agentId, agentId), eq(knowledgeGaps.status, "open")))
    .limit(MAX_GAPS);
  if (!open.length) return 0;
  const config = agentConfigSchema.parse(agent.config);

  // Что агент знает по каждому вопросу: ключевые факты + база знаний (целиком или найденные фрагменты)
  const blocks: string[] = [];
  if (config.knowledge.trim()) blocks.push(`## Ключевые факты\n${config.knowledge.trim()}`);
  let full = false;
  for (const g of open) {
    const kb = await loadKnowledge(agent.clientId, config.kbSourceIds, [g.question]);
    if (kb.mode === "full") {
      if (!full) blocks.push(...kb.docs.map((d) => `## ${d.title}\n${d.content}`));
      full = true;
    } else if (kb.mode === "search") {
      if (kb.pinned && !blocks.some((b) => b.startsWith("## Документы бота"))) {
        blocks.push(`## Документы бота\n${kb.pinned.map((d) => `### ${d.title}\n${d.content}`).join("\n\n")}`);
      }
      if (kb.context) blocks.push(`## Найдено по вопросу ${g.id}\n${kb.context}`);
    }
  }
  const knowledge = blocks.join("\n\n").slice(0, MAX_CHARS);
  if (!knowledge.trim()) return 0;

  const { data, usage, model } = await generateJson<{ results: Verdict[] }>(key, MODEL, {
    system: [
      "Ты проверяешь базу знаний чат-агента компании. Перед тобой вопросы клиентов, на которые агент раньше не смог ответить, и то, что агент знает сейчас.",
      "Для каждого вопроса реши: можно ли теперь ответить на него по существу, опираясь ТОЛЬКО на эти знания? answered=true — только если в знаниях есть конкретный ответ (условия, порядок, цифры, да/нет), а не общие слова рядом с темой.",
      "Если answered=true — в answer коротко (1–3 предложения, по-русски) ответ по знаниям, без выдумок. Иначе answer — пустая строка.",
      "Вопросы про конкретные объекты с невозможными параметрами (вертолётная площадка, 5 спален, если их нет в каталоге): answered=true, если из каталога ясно, что таких нет, — ответ «в каталоге таких нет, ближайшие…».",
    ].join("\n"),
    prompt: `Вопросы:\n${open.map((g) => `${g.id}: ${g.question}`).join("\n")}\n\nЧто агент знает сейчас:\n${knowledge}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "answered", "answer"],
            properties: { id: { type: "string" }, answered: { type: "boolean" }, answer: { type: "string" } },
          },
        },
      },
    },
  });
  await logUsage({ source: "insights", model, usage, agentId, clientId: agent.clientId }).catch(() => null);

  const ids = new Set(open.map((g) => g.id));
  const done = data.results.filter((r) => r.answered && ids.has(r.id) && r.answer.trim().length >= 5);
  for (const r of done) {
    await db
      .update(knowledgeGaps)
      .set({ status: "resolved", answer: `Уже есть в базе знаний: ${r.answer.trim().slice(0, 1000)}` })
      .where(and(eq(knowledgeGaps.id, r.id), eq(knowledgeGaps.status, "open")));
  }
  return done.length;
}

/** Сверить вопросы всех агентов клиента (перед рассылкой владельцу). */
async function recheckClientGaps__(clientId: string): Promise<number> {
  const list = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.clientId, clientId), inArray(agents.status, ["active", "paused"])));
  let n = 0;
  for (const a of list) n += await recheckGaps(a.id).catch((e) => (console.error("gaps recheck failed", a.id, e), 0));
  return n;
}

/** recheckGaps — в области ключей клиента (его ключи ИИ, если заданы). */
export async function recheckGaps(...a: Parameters<typeof recheckGaps__>): ReturnType<typeof recheckGaps__> {
  return withKeys({ agentId: a[0] }, () => recheckGaps__(...a));
}

/** recheckClientGaps — в области ключей клиента (его ключи ИИ, если заданы). */
export async function recheckClientGaps(...a: Parameters<typeof recheckClientGaps__>): ReturnType<typeof recheckClientGaps__> {
  return withKeys({ clientId: a[0] }, () => recheckClientGaps__(...a));
}
