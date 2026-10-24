import "server-only";
import { usingClientKey, type KeyKind } from "@/lib/keys";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { usageLog } from "@/db/schema";
import { findModel } from "@/lib/models";
import type { ChatUsage } from "@/lib/llm/types";

/**
 * Стоимость вызова в USD. Токены, прочитанные из кэша промпта, стоят 10% обычной цены входа.
 * null — цена модели неизвестна (модели вне каталога).
 */
/** Поиск в интернете Anthropic: $10 за 1000 поисков */
const WEB_SEARCH_USD = 0.01;

export function computeCost(model: string, usage: Pick<ChatUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "webSearches">) {
  const price = findModel(model)?.price;
  if (!price) return null;
  const cached = usage.cacheReadTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  return (fresh * price.input + cached * price.input * 0.1 + usage.outputTokens * price.output) / 1e6 + (usage.webSearches ?? 0) * WEB_SEARCH_USD;
}

const providerKind = (model: string): KeyKind => (model.startsWith("openai:") ? "openai" : model.startsWith("openrouter:") ? "openrouter" : "anthropic");

export async function logUsage(entry: {
  source: "channel" | "playground" | "test" | "generate" | "insights";
  model: string;
  usage: ChatUsage;
  agentId?: string | null;
  clientId?: string | null;
  conversationId?: string | null;
  ms?: number;
}) {
  const cost = computeCost(entry.model, entry.usage);
  await db.insert(usageLog).values({
    source: entry.source,
    model: entry.model,
    agentId: entry.agentId ?? null,
    clientId: entry.clientId ?? null,
    conversationId: entry.conversationId ?? null,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    cacheReadTokens: entry.usage.cacheReadTokens ?? 0,
    cost,
    ms: entry.ms,
    ownKey: usingClientKey(providerKind(entry.model)),
  });
  return cost;
}

export function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Расходы всей студии с начала месяца, USD — без операций, оплаченных своими ключами клиентов. */
export async function studioMonthSpend(now = new Date()) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(gte(usageLog.createdAt, monthStart(now)), eq(usageLog.ownKey, false)));
  return Number(row?.total ?? 0);
}

/** Раз в час: расходы студии дошли до 80% или 100% месячного лимита — одно уведомление на каждый порог в месяц. */
export function startStudioLimitWatch() {
  const g = globalThis as unknown as { __studioLimitTimer?: ReturnType<typeof setInterval> };
  if (g.__studioLimitTimer) return;
  const tick = async () => {
    const { getGeneral } = await import("@/lib/general");
    const limit = (await getGeneral()).studioMonthlyLimitUsd;
    if (!limit) return;
    const spent = await studioMonthSpend();
    const level = spent >= limit ? 100 : spent >= limit * 0.8 ? 80 : 0;
    if (!level) return;
    const { getSetting, setSetting } = await import("@/lib/settings");
    const key = `studioLimit:${monthStart().toISOString().slice(0, 7)}`;
    if (((await getSetting<number>(key)) ?? 0) >= level) return;
    await setSetting(key, level);
    const { notifyStudioLimit } = await import("@/lib/notify/telegram");
    await notifyStudioLimit(spent, limit, level);
  };
  g.__studioLimitTimer = setInterval(() => void tick().catch((e) => console.error("studio limit check failed", e)), 60 * 60_000);
  setTimeout(() => void tick().catch(() => {}), 60_000);
}

/** Расходы агента с начала текущего месяца (все источники), USD. */
export async function agentMonthSpend(agentId: string) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.agentId, agentId), gte(usageLog.createdAt, monthStart())));
  return Number(row?.total ?? 0);
}
