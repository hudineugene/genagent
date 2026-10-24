"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n/client";

/** Общие «часы» с шагом в минуту: все отметки времени на странице обновляются вместе. */
let minute = Math.floor(Date.now() / 60_000);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(fn: () => void) {
  listeners.add(fn);
  timer ??= setInterval(() => {
    minute = Math.floor(Date.now() / 60_000);
    for (const l of listeners) l();
  }, 30_000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Начало дня (полночь) в часовом поясе студии, мс. */
function dayKey(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/**
 * Время «по-человечески»: «только что», «5 мин назад», «14:19» (сегодня), «вчера, 14:19», «пн, 14:19» (неделя),
 * «12 окт.» или «12 окт. 2025»; полная дата — при наведении. Часовой пояс — студии.
 */
export function RelTime({ at, className }: { at: number | Date; className?: string }) {
  const { locale, timeZone, t } = useI18n();
  const now = useSyncExternalStore(subscribe, () => minute, () => minute) * 60_000;
  const ms = typeof at === "number" ? at : at.getTime();
  const loc = locale === "uk" ? "uk-UA" : "ru-RU";
  const diff = Math.max(0, now - ms);
  const time = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit", timeZone }).format(ms);
  const rel = new Intl.RelativeTimeFormat(loc, { numeric: "auto", style: "short" });
  const days = Math.round((Date.parse(dayKey(now, timeZone)) - Date.parse(dayKey(ms, timeZone))) / 86_400_000);
  let text: string;
  if (diff < 60_000) text = t.home.justNow;
  else if (diff < 3_600_000) text = rel.format(-Math.floor(diff / 60_000), "minute");
  else if (days === 0) text = time;
  else if (days === 1) text = `${rel.format(-1, "day")}, ${time}`;
  else if (days < 7) text = `${new Intl.DateTimeFormat(loc, { weekday: "short", timeZone }).format(ms)}, ${time}`;
  else {
    const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
    text = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric", timeZone }).format(ms);
  }
  const full = new Intl.DateTimeFormat(loc, { dateStyle: "full", timeStyle: "short", timeZone }).format(ms);
  return (
    <time dateTime={new Date(ms).toISOString()} title={full} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
