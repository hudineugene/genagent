import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, payments } from "@/db/schema";
import { jsonText } from "@/db/dialect";

/**
 * Итог обращения (без ИИ, по переписке): подтверждено — запись, оплата, 👍 или благодарность клиента после ответа;
 * передано менеджеру; клиент вернулся — замолчал после ответа агента и написал снова через сутки–неделю (вопрос,
 * скорее всего, не решён с первого раза); решено по умолчанию — после ответа агента клиент молчит больше суток;
 * открыто — разговор идёт (последнее сообщение моложе суток или агент ещё не ответил).
 */
export type Outcome = "confirmed" | "assumed" | "returned" | "escalated" | "open";

const DAY = 86_400_000;
const THANKS_RE = /(спасиб|дякую|thank|благодар|отлично|чудово|супер|понял|зрозумів|окей|okay|👍|🙏|❤)/i;

type Msg = { role: string; text: string; createdAt: Date; meta: { rating?: "up" | "down" } | null };

export function classify(list: Msg[], now = Date.now(), paid = false): Outcome {
  if (list.some((m) => m.role === "system" && m.text === "handoff")) return "escalated";
  if (paid || list.some((m) => (m.role === "system" && (m.text === "booking_created" || m.text.startsWith("💳"))) || m.meta?.rating === "up")) return "confirmed";
  const talk = list.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "operator");
  const last = talk.at(-1);
  if (!last) return "open";
  const lastUser = [...talk].reverse().find((m) => m.role === "user");
  const before = lastUser ? talk[talk.indexOf(lastUser) - 1] : undefined;
  // Благодарность после ответа агента, без нового вопроса
  if (lastUser && before && before.role !== "user" && THANKS_RE.test(lastUser.text) && !lastUser.text.includes("?") && lastUser.text.length <= 120) return "confirmed";
  // Вернулся: после ответа агента молчал сутки и больше (но не дольше недели) и написал снова
  for (let i = 1; i < talk.length; i++) {
    const gap = talk[i].createdAt.getTime() - talk[i - 1].createdAt.getTime();
    if (talk[i].role === "user" && talk[i - 1].role !== "user" && gap >= DAY && gap <= 7 * DAY) return "returned";
  }
  if (last.role === "user" || now - last.createdAt.getTime() < DAY) return "open";
  return "assumed";
}

export type ResolutionStats = Record<Outcome, number> & { total: number; rate: number | null };

const empty = (): ResolutionStats => ({ confirmed: 0, assumed: 0, returned: 0, escalated: 0, open: 0, total: 0, rate: null });

/** Итоги личных разговоров, где клиент писал за период: всего и по агентам. */
export async function resolutionStats(from: Date, clientId?: string | null, now = Date.now()) {
  const convs = await db
    .select({ id: conversations.id, agentId: conversations.agentId })
    .from(conversations)
    .where(
      and(
        eq(conversations.isTest, false),
        eq(conversations.kind, "dm"),
        gte(conversations.lastMessageAt, from),
        ...(clientId ? [eq(conversations.clientId, clientId)] : []),
        sql`exists (select 1 from messages m where m.conversation_id = ${conversations.id} and m.role = 'user' and m.created_at >= ${from.getTime()})`,
      ),
    );
  const all = empty();
  const byAgent = new Map<string, ResolutionStats>();
  for (let i = 0; i < convs.length; i += 300) {
    const part = convs.slice(i, i + 300);
    const ids = part.map((c) => c.id);
    const [msgs, paid] = await Promise.all([
      db
        .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, createdAt: messages.createdAt, meta: messages.meta })
        .from(messages)
        .where(and(inArray(messages.conversationId, ids), gte(messages.createdAt, new Date(from.getTime() - 7 * DAY)), eq(messages.status, "sent"))),
      db.select({ conversationId: payments.conversationId }).from(payments).where(and(inArray(payments.conversationId, ids), eq(payments.status, "paid"))),
    ]);
    const paidSet = new Set(paid.map((p) => p.conversationId));
    const grouped = new Map<string, Msg[]>();
    for (const m of msgs) grouped.set(m.conversationId, [...(grouped.get(m.conversationId) ?? []), m as Msg]);
    for (const c of part) {
      const list = (grouped.get(c.id) ?? []).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const o = classify(list, now, paidSet.has(c.id));
      const a = byAgent.get(c.agentId) ?? empty();
      for (const s of [all, a]) {
        s[o]++;
        s.total++;
      }
      byAgent.set(c.agentId, a);
    }
  }
  const rate = (s: ResolutionStats) => {
    const closed = s.total - s.open;
    s.rate = closed > 0 ? (s.confirmed + s.assumed) / closed : null;
  };
  rate(all);
  for (const s of byAgent.values()) rate(s);
  return { all, byAgent };
}

/** Откуда приходят клиенты: разговоры, оплаты и выручка по источнику (реклама, истории, кодовые слова, метки ссылок). */
export async function sourceStats(from: Date, clientId?: string | null) {
  const rows = await db
    .select({
      kind: sql<string>`coalesce(${jsonText(conversations.context, "source.kind")}, 'direct')`,
      title: sql<string>`coalesce(${jsonText(conversations.context, "source.title")}, ${jsonText(conversations.context, "source.ref")}, '')`,
      n: sql<number>`count(*)`,
    })
    .from(conversations)
    .where(and(eq(conversations.isTest, false), gte(conversations.createdAt, from), ...(clientId ? [eq(conversations.clientId, clientId)] : [])))
    .groupBy(sql`1`, sql`2`);
  const revenue = await db
    .select({
      kind: sql<string>`coalesce(${jsonText(conversations.context, "source.kind")}, 'direct')`,
      title: sql<string>`coalesce(${jsonText(conversations.context, "source.title")}, ${jsonText(conversations.context, "source.ref")}, '')`,
      currency: payments.currency,
      sum: sql<number>`sum(${payments.amount})`,
      n: sql<number>`count(*)`,
    })
    .from(payments)
    .innerJoin(conversations, eq(conversations.id, payments.conversationId))
    .where(and(eq(payments.status, "paid"), gte(conversations.createdAt, from), ...(clientId ? [eq(payments.clientId, clientId)] : [])))
    .groupBy(sql`1`, sql`2`, payments.currency);
  return rows.map((r) => {
    const rev = revenue.filter((x) => x.kind === r.kind && x.title === r.title);
    return { kind: r.kind, title: r.title, conversations: Number(r.n), paid: rev.reduce((s, x) => s + Number(x.n), 0), revenue: rev.map((x) => `${Math.round(Number(x.sum) * 100) / 100} ${x.currency}`).join(" + ") };
  });
}
