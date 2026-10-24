import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { DEFAULT_LOCALE, LOCALE_COOKIE, getDict, isLocale, type Locale } from ".";

export async function getLocale(): Promise<Locale> {
  // Страницы читают БД (SQLite внутри процесса) — это не должно попадать в пререндер.
  await connection();
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(v)) return v;
  // Язык по умолчанию — из общих настроек студии
  const { getGeneral } = await import("@/lib/general");
  return (await getGeneral().catch(() => null))?.locale ?? DEFAULT_LOCALE;
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: getDict(locale) };
}
