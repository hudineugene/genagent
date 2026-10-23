import "server-only";
import { CalendarError, googleToken } from "./calendar";

/**
 * Google Таблицы через сервисный аккаунт студии: клиент открывает доступ к таблице для адреса сервисного аккаунта
 * (как с календарём) — «Редактор» для выгрузки заявок, «Читатель» для поиска агентом.
 * Адрес API можно подменить (GOOGLE_SHEETS_URL) — для тестов с локальным макетом.
 */
const API = () => process.env.GOOGLE_SHEETS_URL ?? "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export class SheetsError extends Error {}

/** ID таблицы из ссылки (…/spreadsheets/d/<ID>/edit) или сам ID. */
export function spreadsheetId(urlOrId: string) {
  const m = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId.trim())) return urlOrId.trim();
  return null;
}

/** «Лист1» → «'Лист1'» для диапазонов A1. */
const sheetRef = (name: string) => `'${name.replace(/'/g, "''")}'`;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token: string;
  try {
    token = await googleToken(SCOPE);
  } catch (e) {
    throw new SheetsError(e instanceof CalendarError ? e.code : "google_auth_failed");
  }
  const res = await fetch(`${API()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new SheetsError(res.status === 404 ? "sheet_not_found" : res.status === 403 ? "sheet_no_access" : res.status === 400 ? "sheet_bad_range" : "sheet_error");
  return data;
}

export async function readValues(id: string, sheet: string, range = "A1:Z2000"): Promise<string[][]> {
  const data = await call<{ values?: string[][] }>(`/${id}/values/${encodeURIComponent(`${sheetRef(sheet)}!${range}`)}?valueRenderOption=FORMATTED_VALUE`);
  return data.values ?? [];
}

/** Добавить строку в конец; возвращает номер строки (1 — первая). */
export async function appendRow(id: string, sheet: string, row: string[]): Promise<number | null> {
  const data = await call<{ updates?: { updatedRange?: string } }>(
    `/${id}/values/${encodeURIComponent(`${sheetRef(sheet)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: [row] }) },
  );
  const m = data.updates?.updatedRange?.match(/![A-Z]+(\d+)/);
  return m ? Number(m[1]) : null;
}

export async function updateRow(id: string, sheet: string, rowNumber: number, row: string[]) {
  await call(`/${id}/values/${encodeURIComponent(`${sheetRef(sheet)}!A${rowNumber}`)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values: [row] }),
  });
}

/** Шапка таблицы: если первая строка пустая — записать заголовки. */
export async function ensureHeader(id: string, sheet: string, header: string[]) {
  const first = await readValues(id, sheet, "A1:Z1");
  if (!first.length || !first[0].some((c) => String(c).trim())) await updateRow(id, sheet, 1, header);
}

// ---------- поиск агентом ----------

const cache = new Map<string, { at: number; rows: string[][] }>();
const CACHE_MS = 2 * 60_000;

/**
 * Строки таблицы, где встречаются все слова запроса (без учёта регистра), в виде «Заголовок: значение; …».
 * Таблица кэшируется на 2 минуты — агент может спрашивать часто.
 */
export async function searchSheet(id: string, sheet: string, query: string, limit = 15) {
  const key = `${id}|${sheet}`;
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = { at: Date.now(), rows: await readValues(id, sheet) };
    cache.set(key, hit);
  }
  const [header = [], ...rows] = hit.rows;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = rows.filter((r) => {
    const text = r.join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const fmt = (r: string[]) =>
    r
      .map((v, i) => (String(v).trim() ? `${header[i] || `Колонка ${i + 1}`}: ${v}` : ""))
      .filter(Boolean)
      .join("; ");
  return { total: found.length, rows: found.slice(0, limit).map(fmt) };
}
