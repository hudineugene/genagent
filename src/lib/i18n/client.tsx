"use client";

import { createContext, use, type ReactNode } from "react";
import { getDict, type Dict, type Locale } from ".";

/** timeZone — часовой пояс студии (общие настройки) для дат в браузере */
const I18nContext = createContext<{ locale: Locale; t: Dict; timeZone: string } | null>(null);

export function I18nProvider({ locale, timeZone = "Europe/Kyiv", children }: { locale: Locale; timeZone?: string; children: ReactNode }) {
  return <I18nContext value={{ locale, t: getDict(locale), timeZone }}>{children}</I18nContext>;
}

export function useI18n() {
  const v = use(I18nContext);
  if (!v) throw new Error("useI18n must be used within I18nProvider");
  return v;
}
