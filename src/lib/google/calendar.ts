import "server-only";
import { createSign } from "node:crypto";
import { getSetting } from "@/lib/settings";

/**
 * Google Календарь через сервисный аккаунт студии: клиент открывает доступ к своему календарю
 * для адреса сервисного аккаунта («Вносить изменения в мероприятия») — без входа через Google и проверки приложения.
 * Адреса можно подменить переменными окружения — для тестов с локальным макетом.
 */
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const API = () => process.env.GOOGLE_CALENDAR_URL ?? "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

export type GoogleSettings = { clientEmail: string; privateKey: string; projectId?: string };

export class CalendarError extends Error {
  constructor(
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export async function getGoogleSettings() {
  return getSetting<GoogleSettings>("google");
}

let cached: { email: string; token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const s = await getGoogleSettings();
  if (!s) throw new CalendarError("google_not_configured");
  if (cached && cached.email === s.clientEmail && cached.exp - 60_000 > Date.now()) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: s.clientEmail, scope: SCOPE, aud: TOKEN_URL(), iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(s.privateKey).toString("base64url");

  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) throw new CalendarError("google_auth_failed", data.error_description);
  cached = { email: s.clientEmail, token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const code = res.status === 404 ? "calendar_not_found" : res.status === 403 ? "calendar_no_access" : "calendar_error";
    throw new CalendarError(code, data.error?.message);
  }
  return data;
}

/** Занятые интервалы календаря (UTC, мс). */
export async function busyIntervals(calendarId: string, from: Date, to: Date) {
  const r = await call<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
    "/freeBusy",
    { method: "POST", body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }) },
  );
  const cal = r.calendars?.[calendarId];
  if (!cal) throw new CalendarError("calendar_not_found");
  if (cal.errors?.length) {
    throw new CalendarError(cal.errors[0].reason === "notFound" ? "calendar_not_found" : "calendar_no_access", cal.errors[0].reason);
  }
  return (cal.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

export async function createEvent(
  calendarId: string,
  ev: { summary: string; description: string; start: Date; end: Date; timeZone: string },
) {
  const r = await call<{ id: string; htmlLink?: string }>(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
      end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
    }),
  });
  return { id: r.id, link: r.htmlLink ?? null };
}

// ---------- часовые пояса без внешних библиотек ----------

/** Смещение часового пояса в момент времени (мс): локальное − UTC. */
function tzOffset(tz: string, at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** Местное время («2026-10-17», «10:30») в часовом поясе → момент UTC (с учётом перехода на летнее время). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - tzOffset(tz, guess);
  utc = guess - tzOffset(tz, utc);
  return new Date(utc);
}

/** Момент → местные дата, время и день недели (0 — воскресенье). */
export function utcToZoned(at: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: days.indexOf(parts.weekday) };
}

export function addDays(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
