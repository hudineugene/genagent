import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { conversations, knowledgeGaps, messages, usageLog } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { agentFunnels } from "./funnel";

/**
 * Ежедневная сводка в Telegram (бот уведомлений): за последние сутки по каждому агенту — сколько людей написали,
 * сколько получили ответ агента, сколько передано людям (и сколько из них недовольны), оценки, результаты от ботов,
 * новые вопросы без ответа и кто сейчас ждёт человека. Без ИИ — только подсчёт по базе.
 */
export type DailyDigestSettings = {
  enabled: boolean;
  /** Час по Киеву, 0–23 */
  hour: number;
  /** День последней отправки (YYYY-MM-DD по Киеву) */
  lastDay?: string;
};

const KEY = "dailyDigest";
const TZ = "Europe/Kyiv";
export const DAILY_DEFAULTS: DailyDigestSettings = { enabled: true, hour: 20 };
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDailyDigest(): Promise<DailyDigestSettings> {
  return { ...DAILY_DEFAULTS, ...((await getSetting<DailyDigestSettings>(KEY)) ?? {}) };
}

export async function saveDailyDigest(patch: Partial<DailyDigestSettings>) {
  await setSetting(KEY, { ...(await getDailyDigest()), ...patch });
}

function kyivNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type AgentDay = {
  agentId: string;
  title: string;
  wrote: number;
  answered: number;
  handoffs: number;
  upset: number;
  waiting: { conversationId: string; name: string }[];
  newGaps: number;
  results: { label: string; n: number }[];
  ratingUp: number;
  ratingDown: number;
  /** Расход на ИИ за сутки и обычный суточный (среднее за прошлую неделю), $ */
  cost: number;
  usualCost: number;
};

/** Сводка за сутки до sinceMs. Пустая строка — за сутки ничего не было и никто не ждёт. */
export async function dailyDigestHtml(sinceMs = Date.now() - DAY_MS, adminUrl?: string): Promise<string> {
  const since = new Date(sinceMs);
  const funnels = await agentFunnels(sinceMs);
  const byAgent = new Map<string, AgentDay>();
  const rows = await db
    .select({
      agentId: conversations.agentId,
      conversationId: conversations.id,
      externalId: conversations.externalId,
      channelId: conversations.channelId,
      role: messages.role,
      text: messages.text,
      status: messages.status,
      meta: messages.meta,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    // тестовые разговоры — не в счёт
    .where(and(gt(messages.createdAt, since), eq(conversations.isTest, false)));
  const waitingRows = await db
    .select({ agentId: conversations.agentId, id: conversations.id, name: conversations.contactName, handle: conversations.contactHandle })
    .from(conversations)
    .where(and(eq(conversations.needsAttention, true), eq(conversations.isTest, false)));
  const gaps = await db.select({ agentId: knowledgeGaps.agentId }).from(knowledgeGaps).where(and(gt(knowledgeGaps.createdAt, since), eq(knowledgeGaps.status, "open")));

  const titles = new Map(funnels.map((f) => [f.agentId, f.title]));
  const agentIds = new Set([...rows.map((r) => r.agentId), ...waitingRows.map((r) => r.agentId), ...funnels.map((f) => f.agentId)]);
  if (agentIds.size && titles.size < agentIds.size) {
    const { agents, clients } = await import("@/db/schema");
    for (const a of await db.select({ id: agents.id, name: agents.name, client: clients.name }).from(agents).innerJoin(clients, eq(clients.id, agents.clientId))) {
      if (!titles.has(a.id)) titles.set(a.id, `${a.client} · ${a.name}`);
    }
  }
  for (const id of agentIds) {
    const f = funnels.find((x) => x.agentId === id);
    byAgent.set(id, {
      agentId: id,
      title: titles.get(id) ?? id,
      wrote: 0,
      answered: 0,
      handoffs: 0,
      upset: 0,
      waiting: [],
      newGaps: gaps.filter((g) => g.agentId === id).length,
      results: (f?.steps ?? []).filter((s) => !["followup_sent", "brief_started", "brief_prefilled"].includes(s.type)).map((s) => ({ label: s.label, n: s.total })),
      ratingUp: f?.ratingUp ?? 0,
      ratingDown: f?.ratingDown ?? 0,
      cost: 0,
      usualCost: 0,
    });
  }
  const people = new Map<string, { wrote: Set<string>; answered: Set<string> }>();
  for (const r of rows) {
    const day = byAgent.get(r.agentId);
    if (!day) continue;
    const p = people.get(r.agentId) ?? { wrote: new Set<string>(), answered: new Set<string>() };
    people.set(r.agentId, p);
    const who = `${r.channelId}:${r.externalId}`;
    if (r.role === "user") p.wrote.add(who);
    else if (r.role === "assistant" && r.status === "sent") p.answered.add(who);
    else if (r.role === "system" && r.text === "handoff") {
      day.handoffs++;
      if (r.meta?.upset) day.upset++;
    }
  }
  for (const [id, p] of people) {
    const day = byAgent.get(id)!;
    day.wrote = p.wrote.size;
    day.answered = p.answered.size;
  }
  // Расходы на ИИ: за сутки и в среднем за сутки прошлой недели
  const usage = await db
    .select({ agentId: usageLog.agentId, cost: usageLog.cost, createdAt: usageLog.createdAt })
    .from(usageLog)
    .where(gt(usageLog.createdAt, new Date(sinceMs - 7 * DAY_MS)));
  for (const u of usage) {
    const day = u.agentId ? byAgent.get(u.agentId) : undefined;
    if (!day) continue;
    if (u.createdAt.getTime() > sinceMs) day.cost += u.cost ?? 0;
    else day.usualCost += (u.cost ?? 0) / 7;
  }
  for (const w of waitingRows) byAgent.get(w.agentId)?.waiting.push({ conversationId: w.id, name: w.name || w.handle || "клиент" });

  const list = [...byAgent.values()].filter((d) => d.wrote || d.answered || d.handoffs || d.waiting.length || d.results.length || d.newGaps);
  if (!list.length) return "";
  const lines = ["🌙 <b>Агенты за сутки</b>", ""];
  for (const d of list.sort((a, b) => b.wrote - a.wrote)) {
    lines.push(`<b>${esc(d.title)}</b>`);
    if (d.wrote || d.answered || d.handoffs) {
      lines.push(`Написали: ${d.wrote} · ответил агент: ${d.answered}${d.handoffs ? ` · передано людям: ${d.handoffs}` : ""}`);
    }
    if (d.upset) lines.push(`🔴 Недовольны: ${d.upset}`);
    if (d.results.length) lines.push(`Результаты: ${d.results.map((r) => `${esc(r.label)} — ${r.n}`).join(", ")}`);
    if (d.ratingUp || d.ratingDown) lines.push(`Оценки: 👍 ${d.ratingUp} · 👎 ${d.ratingDown}`);
    if (d.cost >= 0.01) {
      const high = d.usualCost > 0 && d.cost > d.usualCost * 2 && d.cost >= 0.5;
      lines.push(`${high ? "⚠️ " : ""}Расход ИИ: ${d.cost.toFixed(2)}${d.usualCost >= 0.01 ? ` (обычно ~${d.usualCost.toFixed(2)} в сутки)` : ""}`);
    }
    if (d.newGaps) lines.push(`Новых вопросов без ответа: ${d.newGaps}${adminUrl ? ` — <a href="${adminUrl}/agents/${d.agentId}/gaps">открыть</a>` : ""}`);
    if (d.waiting.length) {
      const names = d.waiting.slice(0, 5).map((w) => (adminUrl ? `<a href="${adminUrl}/inbox?c=${w.conversationId}">${esc(w.name)}</a>` : esc(w.name)));
      lines.push(`⏳ Ждут человека: ${d.waiting.length} — ${names.join(", ")}${d.waiting.length > 5 ? "…" : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Отправить сводку сейчас. Возвращает false, если за сутки ничего не было. */
export async function sendDailyDigest(): Promise<boolean> {
  const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
  const s = await getNotifySettings();
  const html = await dailyDigestHtml(Date.now() - DAY_MS, s?.adminUrl);
  if (!html) return false;
  await notifyTestsReport(html.slice(0, 3900), s?.adminUrl ? `${s.adminUrl}/inbox` : undefined);
  return true;
}

/** Каждые 20 минут: включено, нужный час по Киеву и сегодня ещё не отправляли. */
export function startDailyDigest() {
  const g = globalThis as unknown as { __dailyTimer?: ReturnType<typeof setInterval> };
  if (g.__dailyTimer) return;
  const tick = async () => {
    const s = await getDailyDigest();
    if (!s.enabled) return;
    const now = kyivNow();
    if (now.hour !== s.hour || s.lastDay === now.day) return;
    await saveDailyDigest({ lastDay: now.day });
    await sendDailyDigest().catch((e) => console.error("daily digest failed", e));
  };
  setTimeout(() => void tick(), 4 * 60_000).unref?.();
  g.__dailyTimer = setInterval(() => void tick(), 20 * 60_000);
  g.__dailyTimer.unref?.();
}
