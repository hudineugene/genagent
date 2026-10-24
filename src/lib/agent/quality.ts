import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations, messages, type MessageMeta } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { loadKnowledge } from "@/lib/kb/store";
import { getSetting, setSetting } from "@/lib/settings";
import { logUsage } from "@/lib/usage";
import { studioTz } from "@/lib/general";
import { getGeneral } from "@/lib/general";

/**
 * Утренняя проверка качества. Раз в сутки (в 8:00 по Киеву) более сильная модель читает вчерашние ответы каждого
 * агента (до 15, сначала самые рискованные: 👎, непроверенные факты, передачи) вместе с базой знаний и ищет:
 * неверный или выдуманный факт, пропущенный вопрос клиента, холодный или резкий тон, не тот язык, лишнюю или
 * пропущенную передачу менеджеру. Замечания — под ответом в «Диалогах» (meta.qa) и короткой сводкой в Telegram.
 * У агента — переключатель config.qualityCheck.
 */
const MODEL = "claude-sonnet-5-5";
const RUN_HOUR = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_AGENT = 15;
const KB_CHARS = 40000;

export type QaIssue = { severity: "low" | "high"; kind: string; note: string; better: string };
export type QaAgentResult = { agentId: string; title: string; checked: number; issues: { conversationId: string; issue: QaIssue }[] };

type Exchange = { messageId: string; conversationId: string; question: string; answer: string; meta: MessageMeta | null; risk: number };

function kyivNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: studioTz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Ответы агента за период с вопросом клиента перед ними; сначала рискованные. */
async function exchanges(agentId: string, from: Date, to: Date): Promise<Exchange[]> {
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    // тестовые разговоры — не проверяем
    .where(and(eq(conversations.agentId, agentId), eq(conversations.kind, "dm"), eq(conversations.isTest, false), gt(conversations.lastMessageAt, from)));
  if (!convs.length) return [];
  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), eq(messages.status, "sent"), lt(messages.createdAt, to), inArray(messages.role, ["user", "assistant", "operator"])))
    .orderBy(asc(messages.createdAt));
  const out: Exchange[] = [];
  const lastQ = new Map<string, string[]>();
  for (const m of rows) {
    if (m.role === "user") {
      lastQ.set(m.conversationId, [...(lastQ.get(m.conversationId) ?? []), m.text + (m.meta?.vision ? ` [фото: ${m.meta.vision.slice(0, 150)}]` : "")].slice(-3));
      continue;
    }
    if (m.role === "operator") {
      lastQ.delete(m.conversationId);
      continue;
    }
    const q = lastQ.get(m.conversationId);
    lastQ.delete(m.conversationId);
    if (!q?.length || m.createdAt < from || m.meta?.qa || m.meta?.followUp || m.meta?.orderNote) continue;
    const risk = (m.meta?.rating === "down" ? 4 : 0) + (m.meta?.unverified?.length ? 3 : 0) + (m.meta?.handoff ? 2 : 0) + (m.text.length > 600 ? 1 : 0);
    out.push({ messageId: m.id, conversationId: m.conversationId, question: q.join("\n"), answer: m.text, meta: m.meta, risk });
  }
  return out.sort((a, b) => b.risk - a.risk).slice(0, PER_AGENT);
}

/** Проверить вчерашние (или за период) ответы агента. Замечания пишутся в meta.qa ответа. */
async function checkAgent__(agentId: string, from: Date, to: Date): Promise<QaAgentResult | null> {
  const key = apiKey("anthropic") ?? "";
  const [row] = await db
    .select({ agent: agents, client: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!key || !row) return null;
  const list = await exchanges(agentId, from, to);
  const title = `${row.client} · ${row.agent.name}`;
  if (!list.length) return { agentId, title, checked: 0, issues: [] };
  const cfg = row.agent.config as { kbSourceIds?: string[] | null; rules?: string; handoff?: string; replyLanguage?: string };
  // База знаний для проверки: поиск по каждой паре «вопрос + ответ» — так находятся фрагменты, на которые опирался
  // консультант (поиск по одному списку вопросов видел только последний, и проверка считала выдумкой то, что в базе есть)
  const blocks: string[] = [];
  const seenText = new Set<string>();
  for (const e of list) {
    const kb = await loadKnowledge(row.agent.clientId, cfg.kbSourceIds, [`${e.question}\n${e.answer}`]).catch(() => ({ mode: "none" as const }));
    const parts =
      kb.mode === "full"
        ? kb.docs.map((d) => `## ${d.title}\n${d.content}`)
        : kb.mode === "search"
          ? [...(kb.pinned ?? []).map((d) => `## ${d.title}\n${d.content}`), kb.context ?? ""]
          : [];
    for (const p of parts) {
      if (p && !seenText.has(p)) {
        seenText.add(p);
        blocks.push(p);
      }
    }
    if (kb.mode === "full") break; // вся база уже целиком
  }
  const kbText = blocks.join("\n\n");
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ issues: (QaIssue & { index: number })[] }>(key, MODEL, {
    system: [
      `Ты проверяешь качество ответов ИИ-консультанта компании «${row.client}» клиентам. Тебе даны пары «вопрос клиента — ответ консультанта» и база знаний компании.`,
      "Найди только настоящие проблемы, которые клиент заметит или которые навредят продажам:",
      "• fact — факт в ответе противоречит базе знаний или выдуман (цена, срок, адрес, наличие, условия, которых нет в базе);",
      "• missed — консультант не ответил на прямой вопрос клиента, хотя ответ есть в базе знаний;",
      "• tone — ответ холодный, резкий, канцелярский или навязчивый;",
      "• language — ответ не на языке клиента;",
      "• handoff — передал менеджеру без нужды (ответ был в базе) или не передал, когда клиент явно просил человека;",
      "• other — другое серьёзное (ответ не по теме, путаница).",
      "Для каждой проблемы: index пары, severity (high — неверный факт, пропущенный вопрос или грубость; low — мелочи), kind, note — коротко по-русски, в чём проблема (до 140 символов), better — как надо было ответить (на языке клиента, 1–3 предложения). Хорошие ответы не включай. Если проблем нет — пустой список.",
      cfg.rules ? `Правила консультанта: ${cfg.rules.slice(0, 2000)}` : "",
      cfg.handoff ? `Когда передавать менеджеру: ${cfg.handoff.slice(0, 600)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: [
      kbText ? `База знаний:\n${kbText.slice(0, KB_CHARS)}` : "База знаний пуста.",
      `Пары:\n${list.map((e, i) => `[${i}] Клиент: ${e.question.slice(0, 800)}\nКонсультант${e.meta?.handoff ? " (передал менеджеру)" : ""}: ${e.answer.slice(0, 1500)}`).join("\n\n")}`,
    ].join("\n\n"),
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["issues"],
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["index", "severity", "kind", "note", "better"],
            properties: {
              index: { type: "integer" },
              severity: { type: "string", enum: ["low", "high"] },
              kind: { type: "string", enum: ["fact", "missed", "tone", "language", "handoff", "other"] },
              note: { type: "string" },
              better: { type: "string" },
            },
          },
        },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId, clientId: row.agent.clientId, ms: Date.now() - started }).catch(() => {});
  const issues: QaAgentResult["issues"] = [];
  const at = Date.now();
  const byIndex = new Map<number, QaIssue>();
  for (const it of data.issues ?? []) {
    if (!list[it.index] || !it.note?.trim() || byIndex.has(it.index)) continue;
    byIndex.set(it.index, { severity: it.severity === "high" ? "high" : "low", kind: it.kind, note: it.note.trim().slice(0, 200), better: (it.better ?? "").trim().slice(0, 800) });
  }
  // Каждый проверенный ответ получает отметку: замечание или «в порядке» — повторно его не проверяем
  for (const [i, e] of list.entries()) {
    const issue = byIndex.get(i);
    await db.update(messages).set({ meta: { ...(e.meta ?? {}), qa: issue ? { ...issue, at } : { ok: true, at } } }).where(eq(messages.id, e.messageId));
    if (issue) issues.push({ conversationId: e.conversationId, issue });
  }
  return { agentId, title, checked: list.length, issues };
}

/** Утренняя проверка всех активных агентов (с включённой проверкой) за прошедшие сутки. */
export async function runQualityCheck(): Promise<QaAgentResult[]> {
  const to = new Date();
  const from = new Date(to.getTime() - DAY_MS);
  const list = await db.select({ id: agents.id, config: agents.config }).from(agents).where(eq(agents.status, "active"));
  const results: QaAgentResult[] = [];
  for (const a of list) {
    if ((a.config as { qualityCheck?: boolean }).qualityCheck === false) continue;
    const r = await checkAgent(a.id, from, to).catch((e) => {
      console.error("quality check failed", a.id, e);
      return null;
    });
    if (r && r.checked) results.push(r);
  }
  return results;
}

const KIND: Record<string, string> = { fact: "факт", missed: "пропустил вопрос", tone: "тон", language: "язык", handoff: "передача", other: "другое" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Сводка для Telegram: по агенту — сколько проверено и главные замечания со ссылками на диалоги. */
export function qualityReportHtml(results: QaAgentResult[], adminUrl?: string) {
  const lines = ["🔎 <b>Проверка ответов агентов за сутки</b>"];
  for (const r of results) {
    const high = r.issues.filter((i) => i.issue.severity === "high").length;
    lines.push(
      "",
      `<b>${esc(r.title)}</b> — проверено ${r.checked}, ${r.issues.length ? `замечаний ${r.issues.length}${high ? ` (важных ${high})` : ""}` : "замечаний нет ✅"}`,
    );
    for (const i of [...r.issues].sort((a, b) => (a.issue.severity === b.issue.severity ? 0 : a.issue.severity === "high" ? -1 : 1)).slice(0, 4)) {
      const link = adminUrl ? ` <a href="${adminUrl}/inbox?c=${i.conversationId}">→</a>` : "";
      lines.push(`${i.issue.severity === "high" ? "🔴" : "🟡"} ${KIND[i.issue.kind] ?? i.issue.kind}: ${esc(i.issue.note)}${link}`);
    }
  }
  return lines.join("\n");
}

export function startQualityCheck() {
  const g = globalThis as unknown as { __qaTimer?: ReturnType<typeof setInterval> };
  if (g.__qaTimer) return;
  const tick = async () => {
    if (!(await getGeneral()).jobs.qualityCheck) return;
    const now = kyivNow();
    if (now.hour !== RUN_HOUR || (await getSetting<string>("qaLastDay")) === now.day) return;
    await setSetting("qaLastDay", now.day);
    try {
      const results = await runQualityCheck();
      // Свежие образцы стиля — по итогам проверки и оценок
      const { refreshExamples } = await import("./examples");
      for (const a of await db.select({ id: agents.id }).from(agents).where(eq(agents.status, "active"))) {
        await refreshExamples(a.id).catch((e) => console.error("examples refresh failed", a.id, e));
      }
      if (!results.length) return;
      const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
      const s = await getNotifySettings();
      await notifyTestsReport(qualityReportHtml(results, s?.adminUrl), s?.adminUrl ? `${s.adminUrl}/inbox` : undefined);
    } catch (e) {
      console.error("quality run failed", e);
    }
  };
  setTimeout(() => void tick(), 6 * 60_000).unref?.();
  g.__qaTimer = setInterval(() => void tick(), 20 * 60_000);
  g.__qaTimer.unref?.();
}

/** checkAgent — в области ключей клиента (его ключи ИИ, если заданы). */
export async function checkAgent(...a: Parameters<typeof checkAgent__>): ReturnType<typeof checkAgent__> {
  return withKeys({ agentId: a[0] }, () => checkAgent__(...a));
}
