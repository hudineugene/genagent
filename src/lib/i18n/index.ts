import { ru, type Dict } from "./ru";
import { uk } from "./uk";

export const LOCALES = ["ru", "uk"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_COOKIE = "locale";

export const LOCALE_LABELS: Record<Locale, string> = { ru: "RU", uk: "UA" };

const DICTS: Record<Locale, Dict> = { ru, uk };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export function getDict(locale: Locale): Dict {
  return DICTS[locale];
}

export type { Dict };
