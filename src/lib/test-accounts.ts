import "server-only";
import { inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Тестовые аккаунты: свои и сотрудников (Telegram ID или @ник, почта). Их разговоры помечаются «тест» — не попадают
 * в аналитику, память о клиентах, обучение и проверки качества; в «Диалогах» — на отдельной вкладке. Удалять не нужно.
 */
const KEY = "testAccounts";
const MAX = 100;

export async function getTestAccounts(): Promise<string[]> {
  return (await getSetting<string[]>(KEY)) ?? [];
}

/** Нормализуем: ID — цифры, ник — @нижний регистр, почта — нижний регистр. */
export function normalizeAccount(raw: string): string | null {
  const s = raw.trim().replace(/^https?:\/\/t\.me\//i, "@");
  if (!s) return null;
  if (/^-?\d{3,20}$/.test(s)) return s;
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) return `@${s.replace(/^@/, "").toLowerCase()}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
  return null;
}

/** Совпадает ли собеседник с тестовым аккаунтом (по ID в канале или нику/почте). */
export function isTestAccount(list: string[], externalId: string, handle?: string | null) {
  if (!list.length) return false;
  const h = (handle ?? "").trim().toLowerCase();
  return list.includes(externalId) || (h ? list.includes(h.startsWith("@") || h.includes("@") ? h : `@${h}`) : false);
}

/** Пометить «тест» все разговоры с аккаунтами из списка. Возвращает, сколько разговоров помечено. */
export async function applyTestAccounts(list: string[]): Promise<number> {
  if (!list.length) return 0;
  const ids = list.filter((a) => !a.includes("@"));
  const handles = list.filter((a) => a.includes("@"));
  const r = await db
    .update(conversations)
    .set({ isTest: true })
    .where(
      or(
        ids.length ? inArray(conversations.externalId, ids) : sql`0`,
        handles.length ? inArray(sql`lower(${conversations.contactHandle})`, handles) : sql`0`,
      ),
    )
    .returning({ id: conversations.id });
  return r.length;
}

/** Сохранить список (строки через запятую/пробел/перенос) и пометить старые разговоры. */
export async function saveTestAccounts(raw: string): Promise<{ list: string[]; marked: number; bad: string[] }> {
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  const list: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const n = normalizeAccount(p);
    if (n) {
      if (!list.includes(n)) list.push(n);
    } else bad.push(p);
  }
  await setSetting(KEY, list.slice(0, MAX));
  const marked = await applyTestAccounts(list.slice(0, MAX));
  return { list: list.slice(0, MAX), marked, bad };
}

/** Добавить аккаунт в список (кнопка «Тестовый» в «Диалогах»). */
export async function addTestAccount(account: string) {
  const n = normalizeAccount(account);
  if (!n) return;
  const list = await getTestAccounts();
  if (!list.includes(n) && list.length < MAX) await setSetting(KEY, [...list, n]);
}
