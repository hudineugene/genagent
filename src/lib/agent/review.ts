import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey as keyOf } from "@/lib/keys";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations, messages } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { getSetting, setSetting } from "@/lib/settings";
import { logUsage } from "@/lib/usage";
import type { AgentConfig } from "./types";
import { studioTz } from "@/lib/general";
import { getGeneral } from "@/lib/general";

/**
 * Разбор недели агента (раз в неделю, дешёвая модель, один вызов на агента):
 *  • «Чего хотят клиенты» — о чём спрашивали, чего хотели, но у компании нет или агент не смог дать,
 *    и идеи для бизнеса — отчёт владельцу, а не просто статистика;
 *  • предложения правок правил агента по разговорам с 👎, передачами людям, недовольством и повторными
 *    вопросами — принимаются одной кнопкой (новая версия агента + автотесты).
 */
const MODEL = "claude-haiku-5-5";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CONVERSATIONS = 3; // меньше разговоров — разбирать нечего, модель не вызываем
const MAX_CHARS = 60_000;
const CONV_CHARS = 1_500;

export type ReviewProposal = {
  id: string;
  title: string;
  why: string;
  field: "rules" | "handoff";
  action: "append" | "replace";
  /** Для replace — точный фрагмент текущего текста, который заменить */
  find: string;
  text: string;
  conversationIds: string[];
  status: "new" | "applied" | "rejected";
};

export type AgentReview = {
  at: number;
  since: number;
  conversations: number;
  summary: string;
  topics: { topic: string; count: number }[];
  unmet: { demand: string; count: number; detail: string }[];
  ideas: string[];
  proposals: ReviewProposal[];
  /** Настроение клиентов за неделю (1–10) и частые жалобы */
  mood?: { score: number; complaints: { complaint: string; count: number }[] };
  /** Цифры недели: оценки, передачи, недовольные, ответы сотрудников */
  stats?: WeekStats;
};

export type WeekStats = { ratingsUp: number; ratingsDown: number; handoffs: number; upset: number; operatorReplies: number; operatorAvg: number | null; operatorLow: number };

const key = (agentId: string) => `agentReview:${agentId}`;

export async function getAgentReview(agentId: string) {
  return getSetting<AgentReview>(key(agentId));
}

export async function saveAgentReview(agentId: string, review: AgentReview) {
  await setSetting(key(agentId), review);
}

/** Разборы последних недель (для ежемесячного отчёта владельцу): последние 10, по времени разбора. */
export async function agentReviewHistory(agentId: string) {
  return (await getSetting<AgentReview[]>(`agentReviewHistory:${agentId}`)) ?? [];
}

async function pushReviewHistory(agentId: string, review: AgentReview) {
  const list = (await agentReviewHistory(agentId)).filter((r) => r.at !== review.at);
  await setSetting(`agentReviewHistory:${agentId}`, [...list, { ...review, proposals: [] }].slice(-10));
}

type Conv = { id: string; lines: string[]; flags: Set<string> };

/** Переписки агента за период — компактно, с пометками 👎 / передан / недоволен / ответил сотрудник — и цифры недели. */
async function transcripts(agentId: string, since: number): Promise<{ list: Conv[]; stats: WeekStats }> {
  const stats: WeekStats = { ratingsUp: 0, ratingsDown: 0, handoffs: 0, upset: 0, operatorReplies: 0, operatorAvg: null, operatorLow: 0 };
  // тестовые разговоры — не в счёт
  const convs = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false)));
  if (!convs.length) return { list: [], stats };
  const scores: number[] = [];
  const rows = await db
    .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, status: messages.status, meta: messages.meta })
    .from(messages)
    .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), gt(messages.createdAt, new Date(since))))
    .orderBy(asc(messages.createdAt));
  const byConv = new Map<string, Conv>();
  for (const m of rows) {
    const c = byConv.get(m.conversationId) ?? { id: m.conversationId, lines: [], flags: new Set<string>() };
    byConv.set(m.conversationId, c);
    const text = m.text.replace(/\s+/g, " ").slice(0, 400);
    if (m.role === "user") c.lines.push(`К: ${text}`);
    else if (m.role === "assistant" && m.status === "sent") {
      const unverified = m.meta?.unverified?.length ? ` [⚠️ нет в базе знаний: ${m.meta.unverified.join(", ")}]` : "";
      c.lines.push(`А: ${text}${m.meta?.rating === "down" ? " [👎]" : ""}${unverified}`);
      if (m.meta?.rating === "down") c.flags.add("👎");
      if (m.meta?.rating === "down") stats.ratingsDown++;
      if (m.meta?.rating === "up") stats.ratingsUp++;
      if (unverified) c.flags.add("данные не из базы");
    } else if (m.role === "operator") {
      const r = m.meta?.operatorReview;
      c.lines.push(`С: ${text}${r ? ` [оценка ${r.score}/10${r.problems.length ? `: ${r.problems.join("; ").slice(0, 200)}` : ""}]` : ""}`);
      c.flags.add("ответил сотрудник");
      stats.operatorReplies++;
      if (r) {
        scores.push(r.score);
        if (r.score < 6) {
          stats.operatorLow++;
          c.flags.add("слабый ответ сотрудника");
        }
      }
    } else if (m.role === "system" && m.text === "handoff") {
      c.flags.add(m.meta?.upset ? "недоволен" : "передан людям");
      stats.handoffs++;
      if (m.meta?.upset) stats.upset++;
    }
  }
  if (scores.length) stats.operatorAvg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  return { list: [...byConv.values()].filter((c) => c.lines.some((l) => l.startsWith("К:"))), stats };
}

type ModelOut = {
  summary: string;
  topics: { topic: string; count: number }[];
  unmet: { demand: string; count: number; detail: string }[];
  ideas: string[];
  mood: number;
  complaints: { complaint: string; count: number }[];
  proposals: { title: string; why: string; field: "rules" | "handoff"; action: "append" | "replace"; find: string; text: string; conversations: number[] }[];
};

/** Разобрать неделю агента. null — разговоров слишком мало (модель не вызывалась). */
async function reviewAgent__(agentId: string, sinceMs = Date.now() - WEEK_MS): Promise<AgentReview | null> {
  const apiKey = keyOf("anthropic");
  const [row] = await db
    .select({ agent: agents, client: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!apiKey || !row) return null;
  const { list, stats } = await transcripts(agentId, sinceMs);
  if (list.length < MIN_CONVERSATIONS) return null;

  // Сначала разговоры с проблемами — они важнее для правок; общий объём ограничен.
  list.sort((a, b) => b.flags.size - a.flags.size);
  const blocks: string[] = [];
  const used: Conv[] = [];
  let total = 0;
  for (const c of list) {
    const flags = c.flags.size ? ` (${[...c.flags].join(", ")})` : "";
    const block = `[${used.length}]${flags}\n${c.lines.join("\n").slice(0, CONV_CHARS)}`;
    if (total + block.length > MAX_CHARS) break;
    blocks.push(block);
    used.push(c);
    total += block.length;
  }

  const config = row.agent.config as AgentConfig;
  const started = Date.now();
  const { data, usage, model } = await generateJson<ModelOut>(apiKey, MODEL, {
    system: [
      `Ты аналитик компании «${row.client}». Перед тобой переписки клиентов с её чат-агентом «${row.agent.name}» за неделю.`,
      "К — клиент, А — агент, С — сотрудник компании. В скобках у разговора пометки: 👎 (клиент оценил ответ плохо), передан людям, недоволен, ответил сотрудник, данные не из базы (агент назвал цифры или контакты, которых нет в базе знаний, — вероятно, выдумал; это повод для правки правил: «не называй цен и контактов, которых нет в базе знаний»).",
      "Сделай две вещи.",
      "1) Отчёт для владельца бизнеса «Чего хотят клиенты» (по-русски, конкретно, без воды):",
      "• summary — 2–3 предложения: главное за неделю;",
      "• topics — до 8 тем, о которых спрашивали, с числом разговоров;",
      "• unmet — до 6 запросов, которые компания не закрыла: клиенты хотели то, чего нет в предложении (товара, услуги, района, цены, времени), или агент не смог дать ответ; count — сколько разговоров, detail — конкретика (что именно искали, цифры);",
      "• ideas — до 3 практичных идей для бизнеса из этих запросов (что добавить, что изменить). Не выдумывай того, чего нет в переписках.",
      "• mood — общее настроение клиентов за неделю от 1 (злые, разочарованы) до 10 (довольны), по тону сообщений, оценкам 👍/👎 и недовольству;",
      "• complaints — до 5 частых жалоб или поводов для недовольства (на агента, сотрудников, сроки, цены, сервис) с числом разговоров; нет жалоб — пустой список.",
      "2) proposals — до 3 правок правил агента, только если в переписках есть явная проблема его поведения (а не нехватка информации — это не правка правил): отвечает длинно или не по делу, предлагает то, что не нужно, не передаёт людям когда надо или передаёт без нужды, повторяется, не уточняет важное, ошибается в тоне.",
      "Для правки: title — коротко суть; why — что видно в переписках; field — rules (правила) или handoff (когда передавать людям); action — append (добавить строку в конец) или replace (заменить фрагмент); find — для replace точный фрагмент текущего текста этого поля, иначе пустая строка; text — новая строка правила (коротко, в повелительном наклонении, на языке текущих правил); conversations — номера разговоров-примеров.",
      "Не предлагай правки, противоречащие текущим правилам без явной причины. Нет явной проблемы — пустой список.",
    ].join("\n"),
    prompt: `Текущие правила агента:\n${config.rules || "(пусто)"}\n\nКогда передавать людям:\n${config.handoff || "(по умолчанию)"}\n\nПереписки (${used.length}):\n\n${blocks.join("\n\n")}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "topics", "unmet", "ideas", "mood", "complaints", "proposals"],
      properties: {
        summary: { type: "string" },
        topics: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["topic", "count"], properties: { topic: { type: "string" }, count: { type: "integer" } } },
        },
        unmet: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["demand", "count", "detail"],
            properties: { demand: { type: "string" }, count: { type: "integer" }, detail: { type: "string" } },
          },
        },
        ideas: { type: "array", items: { type: "string" } },
        mood: { type: "integer" },
        complaints: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["complaint", "count"], properties: { complaint: { type: "string" }, count: { type: "integer" } } },
        },
        proposals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "why", "field", "action", "find", "text", "conversations"],
            properties: {
              title: { type: "string" },
              why: { type: "string" },
              field: { type: "string", enum: ["rules", "handoff"] },
              action: { type: "string", enum: ["append", "replace"] },
              find: { type: "string" },
              text: { type: "string" },
              conversations: { type: "array", items: { type: "integer" } },
            },
          },
        },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId, clientId: row.agent.clientId, ms: Date.now() - started }).catch(() => {});

  const review: AgentReview = {
    at: Date.now(),
    since: sinceMs,
    conversations: list.length,
    summary: data.summary.trim().slice(0, 1000),
    topics: data.topics.slice(0, 8).map((t) => ({ topic: t.topic.slice(0, 200), count: t.count })),
    unmet: data.unmet.slice(0, 6).map((u) => ({ demand: u.demand.slice(0, 200), count: u.count, detail: u.detail.slice(0, 500) })),
    ideas: data.ideas.slice(0, 3).map((i) => i.slice(0, 500)),
    mood: { score: Math.max(1, Math.min(10, Math.round(data.mood || 5))), complaints: (data.complaints ?? []).slice(0, 5).map((c) => ({ complaint: c.complaint.slice(0, 200), count: c.count })) },
    stats,
    proposals: data.proposals
      .slice(0, 3)
      .filter((p) => p.text.trim() && (p.action === "append" || (p.find.trim() && (config[p.field] ?? "").includes(p.find.trim()))))
      .map((p) => ({
        id: randomUUID(),
        title: p.title.slice(0, 200),
        why: p.why.slice(0, 800),
        field: p.field,
        action: p.action,
        find: p.action === "replace" ? p.find.trim() : "",
        text: p.text.trim().slice(0, 1000),
        conversationIds: p.conversations.map((i) => used[i]?.id).filter((id): id is string => Boolean(id)).slice(0, 5),
        status: "new" as const,
      })),
  };
  await saveAgentReview(agentId, review);
  await pushReviewHistory(agentId, review);
  return review;
}

/** Применить правку к настройкам агента (без сохранения). Ошибка — правила уже изменились или слишком длинно. */
export function applyProposalToConfig(config: AgentConfig, p: ReviewProposal): AgentConfig | { error: "changed" | "too_long" } {
  const current = config[p.field] ?? "";
  let next: string;
  if (p.action === "replace") {
    if (!current.includes(p.find)) return { error: "changed" };
    next = current.replace(p.find, p.text);
  } else {
    next = [current.trim(), p.text].filter(Boolean).join("\n");
  }
  if (next.length > (p.field === "rules" ? 5000 : 2000)) return { error: "too_long" };
  return { ...config, [p.field]: next };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Отчёт в Telegram по всем разобранным агентам. */
export function reviewReportHtml(items: { agentId: string; title: string; review: AgentReview }[], adminUrl?: string) {
  const lines = ["🔎 <b>Чего хотят клиенты — итоги недели</b>", ""];
  for (const { agentId, title, review: r } of items) {
    lines.push(`<b>${esc(title)}</b> · разговоров: ${r.conversations}`);
    if (r.summary) lines.push(esc(r.summary));
    if (r.mood) {
      const s = r.stats;
      lines.push(`😊 Настроение клиентов: ${r.mood.score}/10${s ? ` · 👍 ${s.ratingsUp} · 👎 ${s.ratingsDown} · недовольных ${s.upset}` : ""}`);
      for (const c of r.mood.complaints.slice(0, 3)) lines.push(`• жалоба: ${esc(c.complaint)} — ${c.count}`);
    }
    if (r.stats?.operatorAvg != null) lines.push(`🧑‍💼 Ответы сотрудников: средняя оценка ${r.stats.operatorAvg}/10, слабых ${r.stats.operatorLow} из ${r.stats.operatorReplies}`);
    if (r.unmet.length) {
      lines.push("Не закрыли:");
      for (const u of r.unmet.slice(0, 4)) lines.push(`• ${esc(u.demand)} — ${u.count}${u.detail ? `: ${esc(u.detail.slice(0, 160))}` : ""}`);
    }
    if (r.ideas.length) lines.push(`💡 ${esc(r.ideas[0].slice(0, 300))}`);
    const n = r.proposals.filter((p) => p.status === "new").length;
    if (n) lines.push(`✍️ Предложено правок правил: ${n}${adminUrl ? ` — <a href="${adminUrl}/agents/${agentId}/review">посмотреть</a>` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Разобрать неделю всех активных агентов и прислать отчёт. Возвращает число разобранных. */
export async function runWeeklyReview(): Promise<number> {
  const list = await db
    .select({ id: agents.id, name: agents.name, client: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.status, "active"));
  const done: { agentId: string; title: string; review: AgentReview }[] = [];
  for (const a of list) {
    try {
      const review = await reviewAgent(a.id);
      if (review) done.push({ agentId: a.id, title: `${a.client} · ${a.name}`, review });
    } catch (e) {
      console.error("agent review failed", a.id, e);
    }
  }
  if (done.length) {
    const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
    const s = await getNotifySettings();
    await notifyTestsReport(reviewReportHtml(done, s?.adminUrl).slice(0, 3900), s?.adminUrl ? `${s.adminUrl}/agents/${done[0].agentId}/review` : undefined);
  }
  return done.length;
}

/** Раз в неделю: понедельник после 10:00 по Киеву, если на этой неделе ещё не разбирали. */
export function startWeeklyReview() {
  const g = globalThis as unknown as { __reviewTimer?: ReturnType<typeof setInterval> };
  if (g.__reviewTimer) return;
  const tick = async () => {
    if (!(await getGeneral()).jobs.agentReview) return;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: studioTz(), weekday: "short", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date())
        .map((p) => [p.type, p.value]),
    );
    if (parts.weekday !== "Mon" || Number(parts.hour) < 10) return;
    const last = (await getSetting<number>("agentReviewLastRun")) ?? 0;
    if (Date.now() - last < 6 * 24 * 60 * 60 * 1000) return;
    await setSetting("agentReviewLastRun", Date.now());
    await runWeeklyReview().catch((e) => console.error("weekly review failed", e));
  };
  setTimeout(() => void tick(), 6 * 60_000).unref?.();
  g.__reviewTimer = setInterval(() => void tick(), 30 * 60_000);
  g.__reviewTimer.unref?.();
}

/** reviewAgent — в области ключей клиента (его ключи ИИ, если заданы). */
export async function reviewAgent(...a: Parameters<typeof reviewAgent__>): ReturnType<typeof reviewAgent__> {
  return withKeys({ agentId: a[0] }, () => reviewAgent__(...a));
}
