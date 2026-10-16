import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Здоровье каналов: когда канал последний раз что-то получил. Входящие сообщения — из самих сообщений (без записей),
 * уведомления Meta (Instagram, Threads, WhatsApp) — отметкой при каждом подписанном вебхуке: так видно, доходят ли
 * они вообще, даже если сообщения отфильтрованы. Канал, который неделю ничего не получал, — повод проверить подключение.
 */
const KEY = "channelWebhooks";

/** Последнее сообщение клиента по каждому каналу (мс). */
export async function lastInbound(channelIds: string[]): Promise<Map<string, number>> {
  if (!channelIds.length) return new Map();
  const rows = await db
    .select({ channelId: conversations.channelId, at: sql<number>`max(${messages.createdAt})` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(inArray(conversations.channelId, channelIds), eq(messages.role, "user")))
    .groupBy(conversations.channelId);
  return new Map(rows.filter((r) => r.at).map((r) => [r.channelId, Number(r.at)]));
}

/** Когда последний раз пришло уведомление от Meta для канала (мс). */
export async function webhookTimes(): Promise<Record<string, number>> {
  return (await getSetting<Record<string, number>>(KEY)) ?? {};
}

/** Отметить уведомление Meta для канала (не чаще раза в минуту — без лишних записей). */
export async function markWebhook(channelId: string) {
  const all = await webhookTimes();
  if (Date.now() - (all[channelId] ?? 0) < 60_000) return;
  await setSetting(KEY, { ...all, [channelId]: Date.now() });
}

/** Неделю (или ни разу) без сообщений клиентов. */
export function inboundStale(at: number | undefined) {
  return !at || Date.now() - at > 7 * 24 * 3600_000;
}
