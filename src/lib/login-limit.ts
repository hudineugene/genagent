import "server-only";

/**
 * Защита входа от подбора пароля: после 5 неверных попыток за 15 минут вход для этого email
 * закрывается на 15 минут; с одного адреса — после 20 попыток (адрес за прокси бывает общим,
 * поэтому порог выше — чужие ошибки не закроют вход всем). Учёт в памяти процесса —
 * программа работает одним процессом; после перезапуска счётчики обнуляются.
 */
const MAX_FAILS_EMAIL = 5;
const MAX_FAILS_IP = 20;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;

type Entry = { fails: number; first: number; lockedUntil: number };

const g = globalThis as unknown as { __loginLimit?: Map<string, Entry> };
const entries = (g.__loginLimit ??= new Map());

function keys(email: string, ip: string | null) {
  return [`e:${email}`, ...(ip ? [`ip:${ip}`] : [])];
}

/** Сколько ещё ждать (мс), 0 — можно пробовать. */
export function lockedFor(email: string, ip: string | null, now = Date.now()) {
  let wait = 0;
  for (const k of keys(email, ip)) {
    const e = entries.get(k);
    if (e && e.lockedUntil > now) wait = Math.max(wait, e.lockedUntil - now);
  }
  return wait;
}

export function recordFailure(email: string, ip: string | null, now = Date.now()) {
  for (const k of keys(email, ip)) {
    let e = entries.get(k);
    if (!e || now - e.first > WINDOW_MS) e = { fails: 0, first: now, lockedUntil: 0 };
    e.fails += 1;
    if (e.fails >= (k.startsWith("ip:") ? MAX_FAILS_IP : MAX_FAILS_EMAIL)) e.lockedUntil = now + LOCK_MS;
    entries.set(k, e);
  }
  // Старые записи не копим.
  if (entries.size > 5000) {
    for (const [k, e] of entries) if (now - e.first > WINDOW_MS && e.lockedUntil < now) entries.delete(k);
  }
}

export function recordSuccess(email: string, ip: string | null) {
  for (const k of keys(email, ip)) entries.delete(k);
}
