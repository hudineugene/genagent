import "server-only";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientBilling, clients, usageLog, type ClientBilling } from "@/db/schema";

/**
 * Счёт клиента за месяц: себестоимость (ИИ по ключам студии, сообщения WhatsApp), к оплате (абонплата + ИИ сверх
 * включённого объёма с наценкой + каналы с наценкой) и маржа. Расходы по ключам клиента — его, в счёт не входят.
 * Месячный лимит себестоимости: 80% — предупреждение команде, 100% — агенты клиента молчат до следующего месяца.
 */
export type Bill = {
  clientId: string;
  client: string;
  month: string;
  currency: string;
  /** Себестоимость, USD */
  aiCost: number;
  aiOwnKey: number;
  channelCost: number;
  /** К оплате, в валюте счёта */
  fee: number;
  aiBilled: number;
  channelBilled: number;
  total: number;
  /** Маржа в валюте счёта: к оплате минус себестоимость */
  margin: number;
  limitUsd: number | null;
  configured: boolean;
};

export const DEFAULT_BILLING: Omit<ClientBilling, "clientId" | "updatedAt"> = { currency: "USD", usdRate: 1, fee: 0, markupPct: 0, channelMarkupPct: 0, includedUsd: 0, limitUsd: null, alerted: "" };

export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
}

export const currentMonth = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Расчёт по настройкам и расходам (отдельно — так его легко проверить). */
export function computeBill(b: Omit<ClientBilling, "clientId" | "updatedAt">, cost: { ai: number; ownKey: number; channel: number }) {
  const rate = b.usdRate || 1;
  const aiOver = Math.max(0, cost.ai - b.includedUsd);
  const aiBilled = aiOver * (1 + b.markupPct / 100) * rate;
  const channelBilled = cost.channel * (1 + b.channelMarkupPct / 100) * rate;
  const total = b.fee + aiBilled + channelBilled;
  return { aiBilled: r2(aiBilled), channelBilled: r2(channelBilled), total: r2(total), margin: r2(total - (cost.ai + cost.channel) * rate) };
}

/** Себестоимость клиента за период, USD: ИИ по ключам студии, ИИ по ключам клиента, каналы. */
export async function clientCosts(clientId: string | null, from: Date, to: Date) {
  const rows = await db
    .select({
      clientId: usageLog.clientId,
      ai: sql<number>`coalesce(sum(case when ${usageLog.model} not like 'whatsapp:%' and ${usageLog.ownKey} = 0 then ${usageLog.cost} end), 0)`,
      ownKey: sql<number>`coalesce(sum(case when ${usageLog.model} not like 'whatsapp:%' and ${usageLog.ownKey} = 1 then ${usageLog.cost} end), 0)`,
      channel: sql<number>`coalesce(sum(case when ${usageLog.model} like 'whatsapp:%' then ${usageLog.cost} end), 0)`,
    })
    .from(usageLog)
    .where(and(gte(usageLog.createdAt, from), lt(usageLog.createdAt, to), ...(clientId ? [eq(usageLog.clientId, clientId)] : [])))
    .groupBy(usageLog.clientId);
  return new Map(rows.map((r) => [r.clientId ?? "", { ai: Number(r.ai), ownKey: Number(r.ownKey), channel: Number(r.channel) }]));
}

/** Счета всех клиентов (или одного) за месяц. */
export async function bills(month: string, clientId?: string): Promise<Bill[]> {
  const { from, to } = monthRange(month);
  const [list, settings, costs] = await Promise.all([
    db.select({ id: clients.id, name: clients.name }).from(clients).where(clientId ? eq(clients.id, clientId) : undefined),
    db.select().from(clientBilling),
    clientCosts(clientId ?? null, from, to),
  ]);
  const byClient = new Map(settings.map((s) => [s.clientId, s]));
  return list.map((c) => {
    const b = byClient.get(c.id) ?? { ...DEFAULT_BILLING };
    const cost = costs.get(c.id) ?? { ai: 0, ownKey: 0, channel: 0 };
    return {
      clientId: c.id,
      client: c.name,
      month,
      currency: b.currency,
      aiCost: r2(cost.ai),
      aiOwnKey: r2(cost.ownKey),
      channelCost: r2(cost.channel),
      fee: b.fee,
      ...computeBill(b, cost),
      limitUsd: b.limitUsd,
      configured: byClient.has(c.id),
    };
  });
}

/** Себестоимость клиента с начала месяца, USD (для лимита). */
export async function clientMonthCost(clientId: string, now = new Date()) {
  const { from, to } = monthRange(currentMonth(now));
  const c = (await clientCosts(clientId, from, to)).get(clientId);
  return c ? c.ai + c.channel : 0;
}

/**
 * Лимит клиента: true — превышен (агентам молчать). На 80% и 100% — одно предупреждение команде в месяц.
 */
export async function clientOverLimit(clientId: string, now = new Date()): Promise<boolean> {
  const [b] = await db.select().from(clientBilling).where(eq(clientBilling.clientId, clientId));
  if (!b?.limitUsd) return false;
  const spent = await clientMonthCost(clientId, now);
  const pct = spent >= b.limitUsd ? 100 : spent >= b.limitUsd * 0.8 ? 80 : 0;
  const mark = `${currentMonth(now)}:${pct}`;
  if (pct && b.alerted !== mark && !(pct === 80 && b.alerted === `${currentMonth(now)}:100`)) {
    await db.update(clientBilling).set({ alerted: mark }).where(eq(clientBilling.clientId, clientId));
    const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
    const { sendToTeam } = await import("@/lib/notify/telegram");
    await sendToTeam(
      pct === 100
        ? `⛔ <b>${c?.name ?? ""}</b>: месячный лимит расходов $${b.limitUsd} исчерпан ($${spent.toFixed(2)}). Агенты клиента не отвечают до следующего месяца — поднимите лимит в «Биллинге», если нужно.`
        : `⚠️ <b>${c?.name ?? ""}</b>: израсходовано 80% месячного лимита ($${spent.toFixed(2)} из $${b.limitUsd}).`,
    ).catch(() => {});
  }
  return pct === 100;
}
