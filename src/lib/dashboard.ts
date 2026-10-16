import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, kbSources, knowledgeGaps, messages, usageLog } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { monthRange } from "@/lib/agent/report";
import type { AgentReview } from "@/lib/agent/review";
import type { AgentConfig } from "@/lib/agent/types";

/**
 * Главная «Сегодня»: что требует человека прямо сейчас (кто ждёт ответа, правки из разбора недели, вопросы без
 * ответа, бот перестал присылать базу, лимит расходов на исходе) и короткая сводка по клиентам. Только база, без ИИ.
 */
const DAY = 24 * 60 * 60 * 1000;
const SYNC_STALE_MS = DAY;
const BUDGET_WARN = 0.8;

export type Waiting = {
  id: string;
  /** Имя, @ник или пусто — подпись делает страница (contactLabel) */
  name: string;
  handle: string;
  channelType: string;
  preview: string;
  at: Date;
  mode: "ai" | "human";
  upset: boolean;
  client: string;
  color: string;
  agent: string;
};

export type Decision =
  | { kind: "review"; agentId: string; agent: string; client: string; count: number }
  | { kind: "gaps"; agentId: string; agent: string; client: string; count: number }
  | { kind: "sync"; clientId: string; client: string; channel: string; days: number }
  | { kind: "budget"; agentId: string; agent: string; client: string; spent: number; limit: number };

export type ClientSummary = {
  id: string;
  name: string;
  industry: string;
  color: string;
  agents: { id: string; name: string; icon: string; status: "draft" | "active" | "paused" }[];
  conversations: number;
  waiting: number;
  cost: number;
};

function currentKyivMonth() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}`;
}

export async function dashboardData() {
  const now = Date.now();
  const day = new Date(now - DAY);
  const week = new Date(now - 7 * DAY);
  const month = new Date(monthRange(currentKyivMonth()).from);

  const [clientRows, agentRows, waitingRows, dayMessages, costRows, gapRows, convRows, apiChannels] = await Promise.all([
    db.select({ id: clients.id, name: clients.name, industry: clients.industry, color: clients.color }).from(clients).orderBy(desc(clients.createdAt)),
    db.select({ id: agents.id, clientId: agents.clientId, name: agents.name, status: agents.status, config: agents.config }).from(agents).orderBy(agents.createdAt),
    db
      .select({
        id: conversations.id,
        clientId: conversations.clientId,
        agentId: conversations.agentId,
        name: conversations.contactName,
        handle: conversations.contactHandle,
        preview: conversations.lastMessageText,
        at: conversations.lastMessageAt,
        mode: conversations.mode,
        channelType: conversations.channelType,
      })
      .from(conversations)
      // тестовые разговоры — не в счёт
      .where(and(eq(conversations.needsAttention, true), ne(conversations.status, "closed"), eq(conversations.isTest, false)))
      .orderBy(conversations.lastMessageAt),
    db
      .select({ role: messages.role, text: messages.text, status: messages.status, conversationId: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(gt(messages.createdAt, day), eq(conversations.isTest, false))),
    db
      .select({
        agentId: usageLog.agentId,
        clientId: usageLog.clientId,
        day: sql<number>`coalesce(sum(case when ${usageLog.createdAt} > ${day.getTime()} then ${usageLog.cost} end), 0)`,
        week: sql<number>`coalesce(sum(case when ${usageLog.createdAt} > ${week.getTime()} then ${usageLog.cost} end), 0)`,
        month: sql<number>`coalesce(sum(case when ${usageLog.createdAt} > ${month.getTime()} then ${usageLog.cost} end), 0)`,
      })
      .from(usageLog)
      .where(gt(usageLog.createdAt, new Date(Math.min(week.getTime(), month.getTime()))))
      .groupBy(usageLog.agentId, usageLog.clientId),
    db
      .select({ agentId: knowledgeGaps.agentId, n: sql<number>`count(*)` })
      .from(knowledgeGaps)
      .where(eq(knowledgeGaps.status, "open"))
      .groupBy(knowledgeGaps.agentId),
    db
      .select({ clientId: conversations.clientId, n: sql<number>`count(*)` })
      .from(conversations)
      .where(and(gt(conversations.lastMessageAt, week), eq(conversations.isTest, false)))
      .groupBy(conversations.clientId),
    db
      .select({ id: channels.id, name: channels.name, clientId: channels.clientId })
      .from(channels)
      .where(and(eq(channels.type, "api"), eq(channels.enabled, true))),
  ]);

  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  // Кто ждёт человека — сначала те, кто ждёт дольше; недовольных помечаем
  const upsetIds = new Set<string>();
  if (waitingRows.length) {
    const handoffs = await db
      .select({ conversationId: messages.conversationId, meta: messages.meta })
      .from(messages)
      .where(and(inArray(messages.conversationId, waitingRows.map((w) => w.id)), eq(messages.role, "system"), eq(messages.text, "handoff")));
    for (const h of handoffs) if (h.meta?.upset) upsetIds.add(h.conversationId);
  }
  const waiting: Waiting[] = waitingRows.map((w) => ({
    id: w.id,
    name: w.name,
    handle: w.handle,
    channelType: w.channelType,
    preview: w.preview,
    at: w.at,
    mode: w.mode,
    upset: upsetIds.has(w.id),
    client: clientById.get(w.clientId)?.name ?? "",
    color: clientById.get(w.clientId)?.color ?? "#888",
    agent: agentById.get(w.agentId)?.name ?? "",
  }));
  waiting.sort((a, b) => Number(b.upset) - Number(a.upset) || a.at.getTime() - b.at.getTime());

  // Сутки: сколько людей написали, скольким ответил агент, сколько передано людям
  const wrote = new Set<string>();
  const answered = new Set<string>();
  let handoffs = 0;
  for (const m of dayMessages) {
    if (m.role === "user") wrote.add(m.conversationId);
    else if (m.role === "assistant" && m.status === "sent") answered.add(m.conversationId);
    else if (m.role === "system" && m.text === "handoff") handoffs++;
  }
  const spend = { day: 0, month: 0 };
  const agentMonth = new Map<string, number>();
  const clientWeek = new Map<string, number>();
  for (const r of costRows) {
    spend.day += r.day;
    spend.month += r.month;
    if (r.agentId) agentMonth.set(r.agentId, (agentMonth.get(r.agentId) ?? 0) + r.month);
    if (r.clientId) clientWeek.set(r.clientId, (clientWeek.get(r.clientId) ?? 0) + r.week);
  }

  // Что требует решения
  const decisions: Decision[] = [];
  const reviews = await Promise.all(agentRows.map((a) => getSetting<AgentReview>(`agentReview:${a.id}`)));
  agentRows.forEach((a, i) => {
    const client = clientById.get(a.clientId)?.name ?? "";
    const n = reviews[i]?.proposals.filter((p) => p.status === "new").length ?? 0;
    if (n) decisions.push({ kind: "review", agentId: a.id, agent: a.name, client, count: n });
  });
  for (const g of gapRows) {
    const a = agentById.get(g.agentId);
    if (a && g.n) decisions.push({ kind: "gaps", agentId: a.id, agent: a.name, client: clientById.get(a.clientId)?.name ?? "", count: g.n });
  }
  for (const a of agentRows) {
    const limit = (a.config as AgentConfig).monthlyBudgetUsd;
    const spent = agentMonth.get(a.id) ?? 0;
    if (limit && spent >= limit * BUDGET_WARN) {
      decisions.push({ kind: "budget", agentId: a.id, agent: a.name, client: clientById.get(a.clientId)?.name ?? "", spent, limit });
    }
  }
  if (apiChannels.length) {
    const withBotDocs = new Set(
      (await db.selectDistinct({ clientId: kbSources.clientId }).from(kbSources).where(isNotNull(kbSources.externalKey))).map((r) => r.clientId),
    );
    for (const ch of apiChannels) {
      if (!withBotDocs.has(ch.clientId)) continue;
      const at = await getSetting<number>(`kbSyncAt:${ch.id}`);
      if (!at || now - at < SYNC_STALE_MS) continue;
      decisions.push({ kind: "sync", clientId: ch.clientId, client: clientById.get(ch.clientId)?.name ?? "", channel: ch.name, days: Math.floor((now - at) / DAY) });
    }
  }

  const convByClient = new Map(convRows.map((r) => [r.clientId, r.n]));
  const clientList: ClientSummary[] = clientRows.map((c) => ({
    id: c.id,
    name: c.name,
    industry: c.industry ?? "",
    color: c.color,
    agents: agentRows
      .filter((a) => a.clientId === c.id)
      .map((a) => ({ id: a.id, name: a.name, icon: (a.config as AgentConfig).icon || "🤖", status: a.status })),
    conversations: convByClient.get(c.id) ?? 0,
    waiting: waitingRows.filter((w) => w.clientId === c.id).length,
    cost: clientWeek.get(c.id) ?? 0,
  }));

  return {
    waiting,
    today: { wrote: wrote.size, answered: answered.size, handoffs, spendDay: spend.day, spendMonth: spend.month },
    decisions,
    clients: clientList,
  };
}
