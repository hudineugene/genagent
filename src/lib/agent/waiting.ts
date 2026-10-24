import "server-only";
import { and, desc, eq, inArray, like, ne, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { studioTz } from "@/lib/general";

/**
 * Напоминания, если клиент ждёт человека: клиента передали людям (диалог «требует внимания»), а после его
 * последнего сообщения никто из людей не ответил — ни в «Диалогах», ни в самом боте (ответы оттуда приходят
 * журналом переписки). Через firstMin минут — напоминание в Telegram с кнопкой «Ответить», через secondMin — 🔴.
 * Только в рабочие часы (по Киеву); ночное ожидание — одним напоминанием утром. Без ИИ.
 */
export type WaitingSettings = {
  enabled: boolean;
  firstMin: number;
  secondMin: number;
  /** Рабочие часы по Киеву: с fromHour до toHour */
  fromHour: number;
  toHour: number;
};

const KEY = "waitReminders";
export const WAITING_DEFAULTS: WaitingSettings = { enabled: true, firstMin: 20, secondMin: 60, fromHour: 9, toHour: 20 };
const CHECK_EVERY_MS = 5 * 60 * 1000;
// Ждут дольше трёх суток — давно забытые диалоги: не напоминаем (они видны в «Диалогах» и в ежедневной сводке)
const MAX_WAIT_MIN = 3 * 24 * 60;
const STATE = (id: string) => `waiting:${id}`;

export async function getWaitingSettings(): Promise<WaitingSettings> {
  return { ...WAITING_DEFAULTS, ...((await getSetting<WaitingSettings>(KEY)) ?? {}) };
}

export async function saveWaitingSettings(patch: Partial<WaitingSettings>) {
  await setSetting(KEY, { ...(await getWaitingSettings()), ...patch });
}

function kyivHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: studioTz(), hour: "2-digit", hourCycle: "h23" }).format(now));
}

/** С какого момента клиент ждёт: первое его сообщение после последнего ответа человека; null — не ждёт. */
export function waitingSince(rows: { role: string; createdAt: Date; meta?: { kind?: string } | null }[]) {
  // rows — от новых к старым. Реакция и нажатие кнопки меню — не вопрос к человеку
  let since: Date | null = null;
  for (const m of rows) {
    if (m.role === "operator") break;
    if (m.role === "user" && m.meta?.kind !== "reaction" && m.meta?.kind !== "button") since = m.createdAt;
  }
  return since;
}

type State = { since: number; stage: number };

export async function runWaitingReminders(now = Date.now()) {
  const s = await getWaitingSettings();
  const waiting = await db
    .select({ id: conversations.id })
    .from(conversations)
    // тестовые разговоры — менеджерам не напоминаем
    .where(and(eq(conversations.needsAttention, true), ne(conversations.status, "closed"), eq(conversations.isTest, false)));
  const ids = waiting.map((w) => w.id);
  // Кто больше не ждёт — его отметки убираем
  await db.delete(settings).where(and(like(settings.key, "waiting:%"), ids.length ? notInArray(settings.key, ids.map(STATE)) : undefined));
  if (!s.enabled || !ids.length) return 0;
  const hour = kyivHour(new Date(now));
  const inHours = s.fromHour <= s.toHour ? hour >= s.fromHour && hour < s.toHour : hour >= s.fromHour || hour < s.toHour;
  if (!inHours) return 0;

  const rows = await db
    .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), inArray(messages.role, ["user", "operator"])))
    .orderBy(desc(messages.createdAt));
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byConv.get(r.conversationId) ?? [];
    if (list.length < 60) list.push(r);
    byConv.set(r.conversationId, list);
  }

  let sent = 0;
  const { notifyWaiting } = await import("@/lib/notify/telegram");
  for (const id of ids) {
    const list = byConv.get(id) ?? [];
    const since = waitingSince(list);
    if (!since) continue;
    const minutes = Math.floor((now - since.getTime()) / 60_000);
    if (minutes > MAX_WAIT_MIN) continue;
    const prev = (await getSetting<State>(STATE(id))) ?? null;
    const stage = prev && prev.since === since.getTime() ? prev.stage : 0;
    const target = minutes >= s.secondMin ? 2 : minutes >= s.firstMin ? 1 : 0;
    if (target <= stage) continue;
    await setSetting(STATE(id), { since: since.getTime(), stage: target } satisfies State);
    const lastText = list.find((m) => m.role === "user")?.text ?? "";
    await notifyWaiting(id, minutes, target === 2, lastText);
    sent++;
  }
  return sent;
}

export function startWaitingReminders() {
  const g = globalThis as unknown as { __waitingTimer?: ReturnType<typeof setInterval> };
  if (g.__waitingTimer) return;
  const tick = () => void runWaitingReminders().catch((e) => console.error("waiting reminders failed", e));
  setTimeout(tick, 2 * 60_000).unref?.();
  g.__waitingTimer = setInterval(tick, CHECK_EVERY_MS);
  g.__waitingTimer.unref?.();
}
