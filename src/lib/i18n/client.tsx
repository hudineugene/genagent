"use client";

import { createContext, use, type ReactNode } from "react";
import { getDict, type Dict, type Locale } from ".";

const I18nContext = createContext<{ locale: Locale; t: Dict } | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <I18nContext value={{ locale, t: getDict(locale) }}>{children}</I18nContext>;
}

export function useI18n() {
  const v = use(I18nContext);
  if (!v) throw new Error("useI18n must be used within I18nProvider");
  return v;
}
