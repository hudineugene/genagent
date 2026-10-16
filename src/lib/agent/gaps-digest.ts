import "server-only";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Раз в неделю (понедельник, 10:00 по Киеву) владельцам клиентов — вопросы клиентов, на которые агент не знал ответа,
 * с кнопкой «✍️ Ответить» (ответ сразу попадает в базу знаний). Только тем клиентам, у кого подписан владелец.
 */
const KEY = "ownerGapsDigest";
const TZ = "Europe/Kyiv";
const WEEKDAY = "Mon";
const HOUR = 10;

function kyivNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hour: Number(parts.hour) };
}

/** Разослать всем владельцам сейчас. Возвращает число клиентов, которым ушли вопросы. */
export async function sendOwnerGapsDigest(): Promise<number> {
  const { getNotifySettings, sendGapsToOwners } = await import("@/lib/notify/telegram");
  const s = await getNotifySettings();
  let sent = 0;
  for (const clientId of new Set((s?.owners ?? []).map((o) => o.clientId))) {
    if ((await sendGapsToOwners(clientId).catch(() => 0)) > 0) sent++;
  }
  return sent;
}

export function startOwnerGapsDigest() {
  const g = globalThis as unknown as { __ownerGapsTimer?: ReturnType<typeof setInterval> };
  if (g.__ownerGapsTimer) return;
  const tick = async () => {
    const now = kyivNow();
    if (now.weekday !== WEEKDAY || now.hour !== HOUR) return;
    const last = await getSetting<{ lastDay?: string }>(KEY);
    if (last?.lastDay === now.day) return;
    await setSetting(KEY, { lastDay: now.day });
    await sendOwnerGapsDigest().catch((e) => console.error("owner gaps digest failed", e));
  };
  setTimeout(() => void tick(), 6 * 60_000).unref?.();
  g.__ownerGapsTimer = setInterval(() => void tick(), 20 * 60_000);
  g.__ownerGapsTimer.unref?.();
}
