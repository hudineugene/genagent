import "server-only";
import { and, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { channels, clients, kbSources, usageLog } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Фоновое наблюдение (раз в 30 минут, без ИИ), предупреждения — в Telegram через бот уведомлений:
 *  • резкий рост расходов на ИИ у клиента (например, кто-то засыпает бота сообщениями);
 *  • свой бот клиента давно не присылал базу знаний — агент может отвечать по устаревшим ценам и объектам;
 *  • справочник, добавленный в студии, давно не обновлялся — правила (налоги, законы) могли измениться.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Расходы: за последний час не меньше $0,50 и в 5 раз больше обычного часа (среднее за неделю)
const SPIKE_MIN_USD = 0.5;
const SPIKE_FACTOR = 5;
// Свой бот присылает базу не реже раза в 6 часов — сутки тишины значат, что синхронизация сломалась
const SYNC_STALE_MS = DAY;
// Справочники из студии: напоминание, если не обновлялись полгода (не чаще раза в месяц на справочник)
const REFERENCE_OLD_MS = 180 * DAY;
const REFERENCE_MIN_CHARS = 5000;

async function notify(html: string, path?: string) {
  const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
  const s = await getNotifySettings();
  await notifyTestsReport(html, s?.adminUrl && path ? `${s.adminUrl}${path}` : undefined);
}

/** Не чаще раза в period для ключа: true — можно сообщать (и отметка поставлена). */
async function once(key: string, period: number) {
  const last = (await getSetting<number>(`watch:${key}`)) ?? 0;
  if (Date.now() - last < period) return false;
  await setSetting(`watch:${key}`, Date.now());
  return true;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => `$${n.toFixed(2)}`;

async function spendSpikes() {
  const now = Date.now();
  const rows = await db
    .select({
      clientId: usageLog.clientId,
      lastHour: sql<number>`coalesce(sum(case when ${usageLog.createdAt} > ${now - HOUR} then ${usageLog.cost} end), 0)`,
      week: sql<number>`coalesce(sum(case when ${usageLog.createdAt} <= ${now - HOUR} then ${usageLog.cost} end), 0)`,
    })
    .from(usageLog)
    .where(and(isNotNull(usageLog.clientId), gt(usageLog.createdAt, new Date(now - 7 * DAY - HOUR))))
    .groupBy(usageLog.clientId);
  for (const r of rows) {
    const usual = r.week / (7 * 24);
    if (r.lastHour < SPIKE_MIN_USD || r.lastHour < usual * SPIKE_FACTOR) continue;
    if (!(await once(`spend:${r.clientId}`, 6 * HOUR))) continue;
    const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, r.clientId!));
    await notify(
      `⚠️ <b>Резкий рост расходов на ИИ</b>\n${esc(c?.name ?? "клиент")}: ${usd(r.lastHour)} за последний час (обычно ~${usd(usual)} в час).\nВозможно, кто-то засыпает бота сообщениями. Проверьте «Диалоги» и при необходимости поставьте месячный лимит у агента.`,
      "/inbox",
    );
  }
}

async function staleSync() {
  const list = await db
    .select({ id: channels.id, name: channels.name, clientId: channels.clientId, client: clients.name })
    .from(channels)
    .innerJoin(clients, eq(clients.id, channels.clientId))
    .where(and(eq(channels.type, "api"), eq(channels.enabled, true)));
  for (const ch of list) {
    // Только боты, которые вообще присылают базу (у клиента есть документы с ключом своего бота)
    const [hasBotDocs] = await db
      .select({ id: kbSources.id })
      .from(kbSources)
      .where(and(eq(kbSources.clientId, ch.clientId), isNotNull(kbSources.externalKey)))
      .limit(1);
    const at = await getSetting<number>(`kbSyncAt:${ch.id}`);
    if (!hasBotDocs || !at || Date.now() - at < SYNC_STALE_MS) continue;
    if (!(await once(`sync:${ch.id}`, DAY))) continue;
    const days = Math.floor((Date.now() - at) / DAY);
    await notify(
      `⚠️ <b>Бот не обновляет базу знаний агента</b>\n${esc(ch.client)} · ${esc(ch.name)}: последний раз ${days >= 1 ? `${days} дн. назад` : "больше суток назад"}.\nАгент может отвечать по устаревшим ценам, объектам или акциям. Проверьте, работает ли бот и подключение к GenAgent в его настройках.`,
      `/clients/${ch.clientId}?tab=kb`,
    );
  }
}

async function oldReferences() {
  const old = await db
    .select({ id: kbSources.id, title: kbSources.title, clientId: kbSources.clientId, updatedAt: kbSources.updatedAt, client: clients.name })
    .from(kbSources)
    .innerJoin(clients, eq(clients.id, kbSources.clientId))
    .where(and(isNull(kbSources.externalKey), gt(kbSources.chars, REFERENCE_MIN_CHARS), lt(kbSources.updatedAt, new Date(Date.now() - REFERENCE_OLD_MS))));
  for (const s of old) {
    if (!(await once(`ref:${s.id}`, 30 * DAY))) continue;
    const months = Math.floor((Date.now() - s.updatedAt.getTime()) / (30 * DAY));
    await notify(
      `📚 <b>Справочник давно не обновлялся</b>\n${esc(s.client)}: «${esc(s.title)}» — ${months} мес.\nНалоги, законы и правила могли измениться. Стоит пересмотреть и обновить в базе знаний клиента.`,
      `/clients/${s.clientId}?tab=kb`,
    );
  }
}

export async function runWatch() {
  for (const [name, fn] of [["spend", spendSpikes], ["sync", staleSync], ["references", oldReferences]] as const) {
    try {
      await fn();
    } catch (e) {
      console.error(`watch ${name} failed`, e);
    }
  }
}

export function startWatch() {
  const g = globalThis as unknown as { __watchTimer?: ReturnType<typeof setInterval> };
  if (g.__watchTimer) return;
  setTimeout(() => void runWatch(), 8 * 60_000).unref?.();
  g.__watchTimer = setInterval(() => void runWatch(), 30 * 60_000);
  g.__watchTimer.unref?.();
}
