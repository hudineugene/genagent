import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { usageLog } from "@/db/schema";
import { findModel } from "@/lib/models";
import type { ChatUsage } from "@/lib/llm/types";

/**
 * Стоимость вызова в USD. Токены, прочитанные из кэша промпта, стоят 10% обычной цены входа.
 * null — цена модели неизвестна (модели вне каталога).
 */
export function computeCost(model: string, usage: Pick<ChatUsage, "inputTokens" | "outputTokens" | "cacheReadTokens">) {
  const price = findModel(model)?.price;
  if (!price) return null;
  const cached = usage.cacheReadTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  return (fresh * price.input + cached * price.input * 0.1 + usage.outputTokens * price.output) / 1e6;
}

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
  });
  return cost;
}

export function monthStart(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Расходы агента с начала текущего месяца (все источники), USD. */
export async function agentMonthSpend(agentId: string) {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.agentId, agentId), gte(usageLog.createdAt, monthStart())));
  return Number(row?.total ?? 0);
}
