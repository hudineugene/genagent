"use client";

import { useSyncExternalStore } from "react";
import { Lightbulb, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

const EVENT = "genagent:tips";
const read = (id: string) => () => {
  try {
    return localStorage.getItem(`tip-${id}`) === "1";
  } catch {
    return true;
  }
};
const subscribe = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** Подсказка «что здесь и зачем» при первом открытии раздела; крестик — больше не показывать (в этом браузере). */
export function SectionTip({ id }: { id: "analytics" | "map" | "review" }) {
  const { t } = useI18n();
  const text = t.shell.tips[id];
  // На сервере подсказку не рисуем: решение — только по браузеру, чтобы не мигала
  const hidden = useSyncExternalStore(subscribe, read(id), () => true);
  if (hidden) return null;
  return (
    <div role="note" className="animate-page-in mb-4 flex items-start gap-3 rounded-2xl border border-accent/25 bg-accent-soft/60 px-4 py-3 text-sm">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1">{text}</p>
      <button
        type="button"
        aria-label={t.shell.tipHide}
        title={t.shell.tipHide}
        onClick={() => {
          try {
            localStorage.setItem(`tip-${id}`, "1");
          } catch {}
          window.dispatchEvent(new Event(EVENT));
        }}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface hover:text-text"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
