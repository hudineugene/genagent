import "server-only";
import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { jsonText } from "@/db/dialect";
import { clients, conversations, messages, payments, usageLog } from "@/db/schema";
import { studioDayStart } from "@/lib/general";

const DAY = 24 * 3600_000;
const DAYS = 14;

export type HomeTrends = { wrote: number[]; answered: number[]; handoffs: number[]; spend: number[] };
export type FeedItem = {
  kind: "new" | "handoff" | "hot" | "paid";
  at: number;
  conversationId: string | null;
  contact: string;
  client: string;
  color: string;
  amount?: string;
};

/** Ряды за 14 дней (старые → новые) для плиток «Сегодня»: написали, ответил агент, передано людям, расходы ИИ. */
export async function homeTrends(ids: string[] | null): Promise<HomeTrends> {
  const today = studioDayStart().getTime();
  const from = new Date(today - (DAYS - 1) * DAY);
  const scopeConv = ids ? inArray(conversations.clientId, ids.length ? ids : ["-"]) : undefined;
  const [rows, costs] = await Promise.all([
    db
      .select({ role: messages.role, text: messages.text, status: messages.status, at: messages.createdAt, conv: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(gte(messages.createdAt, from), eq(conversations.isTest, false), scopeConv))
      .limit(100_000),
    db
      .select({ at: usageLog.createdAt, cost: usageLog.cost })
      .from(usageLog)
      .where(and(gte(usageLog.createdAt, from), ids ? inArray(usageLog.clientId, ids.length ? ids : ["-"]) : undefined))
      .limit(100_000),
  ]);
  const idx = (d: Date) => Math.max(0, Math.min(DAYS - 1, DAYS - 1 - Math.floor((today + DAY - 1 - d.getTime()) / DAY)));
  const wrote = Array.from({ length: DAYS }, () => new Set<string>());
  const answered = Array.from({ length: DAYS }, () => new Set<string>());
  const handoffs = Array(DAYS).fill(0);
  const spend = Array(DAYS).fill(0);
  for (const r of rows) {
    const i = idx(r.at);
    if (r.role === "user") wrote[i].add(r.conv);
    else if (r.role === "assistant" && r.status === "sent") answered[i].add(r.conv);
    else if (r.role === "system" && r.text === "handoff") handoffs[i]++;
  }
  for (const c of costs) spend[idx(c.at)] += c.cost;
  return { wrote: wrote.map((s) => s.size), answered: answered.map((s) => s.size), handoffs, spend: spend.map((v) => Math.round(v * 100) / 100) };
}

/** Живая лента главной: новые разговоры, передачи менеджеру, горячие клиенты и оплаты за 3 дня. */
export async function homeFeed(ids: string[] | null, limit = 14): Promise<FeedItem[]> {
  const since = new Date(Date.now() - 3 * DAY);
  const own = ids ? inArray(conversations.clientId, ids.length ? ids : ["-"]) : undefined;
  const conv = { id: conversations.id, name: conversations.contactName, handle: conversations.contactHandle, client: clients.name, color: clients.color };
  const [fresh, handoffs, hot, paid] = await Promise.all([
    db
      .select({ ...conv, at: conversations.createdAt })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(and(gt(conversations.createdAt, since), eq(conversations.isTest, false), own))
      .orderBy(desc(conversations.createdAt))
      .limit(limit),
    db
      .select({ ...conv, at: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(and(eq(messages.role, "system"), eq(messages.text, "handoff"), gt(messages.createdAt, since), eq(conversations.isTest, false), own))
      .orderBy(desc(messages.createdAt))
      .limit(limit),
    db
      .select({ ...conv, at: conversations.lastMessageAt })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(and(sql`${jsonText(conversations.context, "lead.temperature")} = 'hot'`, gt(conversations.lastMessageAt, since), eq(conversations.isTest, false), own))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit),
    db
      .select({ id: payments.conversationId, amount: payments.amount, currency: payments.currency, at: payments.paidAt, client: clients.name, color: clients.color })
      .from(payments)
      .innerJoin(clients, eq(clients.id, payments.clientId))
      .where(and(eq(payments.status, "paid"), gt(payments.paidAt, since), ids ? inArray(payments.clientId, ids.length ? ids : ["-"]) : undefined))
      .orderBy(desc(payments.paidAt))
      .limit(limit),
  ]);
  const who = (r: { name: string | null; handle: string | null }) => r.name || r.handle || "";
  const items: FeedItem[] = [
    ...fresh.map((r) => ({ kind: "new" as const, at: r.at.getTime(), conversationId: r.id, contact: who(r), client: r.client, color: r.color })),
    ...handoffs.map((r) => ({ kind: "handoff" as const, at: r.at.getTime(), conversationId: r.id, contact: who(r), client: r.client, color: r.color })),
    ...hot.map((r) => ({ kind: "hot" as const, at: r.at.getTime(), conversationId: r.id, contact: who(r), client: r.client, color: r.color })),
    ...paid.map((r) => ({ kind: "paid" as const, at: r.at?.getTime() ?? 0, conversationId: r.id, contact: "", client: r.client, color: r.color, amount: `${r.amount} ${r.currency}` })),
  ];
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}
