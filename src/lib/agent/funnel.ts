import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, agents, clients, conversations, messages } from "@/db/schema";

/**
 * Воронка агента за период: сколько людей поговорили с агентом и сколько из них потом дошли до результата
 * (события от бота: бриф, заявка, просмотр, бронь, оплата…), плюс оценки ответов 👍/👎.
 */
export type FunnelStep = { type: string; label: string; total: number; assisted: number; value: number };
export type AgentFunnel = {
  agentId: string;
  clientId: string;
  title: string;
  /** Людей, которым агент ответил за период */
  talked: number;
  steps: FunnelStep[];
  /** Людей, поговоривших с агентом, у которых потом было хоть одно событие-результат */
  converted: number;
  ratingUp: number;
  ratingDown: number;
};

const RATING = new Set(["rating_up", "rating_down"]);
// Шаги, которые показываем, но результатом не считаем (конверсия — только бриф, заявка, просмотр, оплата…).
const NOT_RESULT = new Set(["followup_sent", "brief_started", "brief_prefilled"]);

export async function agentFunnels(sinceMs: number): Promise<AgentFunnel[]> {
  const since = new Date(sinceMs);
  const list = await db
    .select({ id: agents.id, name: agents.name, client: clients.name, clientId: clients.id })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.status, "active"));
  const out: AgentFunnel[] = [];
  for (const a of list) {
    const talkedRows = await db
      .selectDistinct({ externalId: conversations.externalId, channelId: conversations.channelId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.agentId, a.id), eq(messages.role, "assistant"), gt(messages.createdAt, since)));
    const events = await db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.agentId, a.id), gt(agentEvents.createdAt, since)));
    if (!talkedRows.length && !events.length) continue;

    const steps = new Map<string, FunnelStep>();
    const convertedUsers = new Set<string>();
    let ratingUp = 0;
    let ratingDown = 0;
    for (const e of events) {
      if (e.type === "rating_up") ratingUp++;
      else if (e.type === "rating_down") ratingDown++;
      if (RATING.has(e.type)) continue;
      const step = steps.get(e.type) ?? { type: e.type, label: e.label || e.type, total: 0, assisted: 0, value: 0 };
      step.total++;
      if (e.assisted) {
        step.assisted++;
        if (!NOT_RESULT.has(e.type)) convertedUsers.add(`${e.channelId}:${e.externalUserId}`);
      }
      step.value += e.value ?? 0;
      steps.set(e.type, step);
    }
    out.push({
      agentId: a.id,
      clientId: a.clientId,
      title: `${a.client} · ${a.name}`,
      talked: new Set(talkedRows.map((r) => `${r.channelId}:${r.externalId}`)).size,
      steps: [...steps.values()].sort((x, y) => y.total - x.total),
      converted: convertedUsers.size,
      ratingUp,
      ratingDown,
    });
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");

/** Текст еженедельного отчёта для Telegram (HTML). Пусто — нечего показать. */
export function funnelReportHtml(funnels: AgentFunnel[]) {
  if (!funnels.length) return "";
  const lines = ["📈 <b>Агенты за неделю</b>", ""];
  for (const f of funnels) {
    lines.push(`<b>${esc(f.title)}</b>`);
    lines.push(`Поговорили с агентом: ${f.talked}`);
    if (f.steps.length) {
      for (const s of f.steps) {
        lines.push(`• ${esc(s.label)}: ${s.total}${s.assisted ? ` (после агента — ${s.assisted})` : ""}${s.value ? ` · ${num(s.value)}` : ""}`);
      }
      if (f.talked) lines.push(`Дошли до результата после разговора: ${f.converted} из ${f.talked} (${Math.round((f.converted / f.talked) * 100)}%)`);
    } else {
      lines.push("Событий от бота пока нет.");
    }
    if (f.ratingUp || f.ratingDown) lines.push(`Оценки ответов: 👍 ${f.ratingUp} · 👎 ${f.ratingDown}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Последние ответы с 👎 — для страницы аналитики. */
export async function recentDislikes(agentIds: string[], limit = 10) {
  if (!agentIds.length) return [];
  const rows = await db
    .select({ id: messages.id, text: messages.text, meta: messages.meta, conversationId: messages.conversationId, createdAt: messages.createdAt, agentId: conversations.agentId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(inArray(conversations.agentId, agentIds), eq(messages.role, "assistant")));
  return rows
    .filter((r) => r.meta?.rating === "down")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
