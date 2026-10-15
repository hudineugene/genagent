"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "@/components/ui";

// Панель «О диалоге» справа: открыта/закрыта — запоминаем в браузере (по умолчанию открыта).
const KEY = "inboxInfo";
const EVENT = "genagent:inbox-info";

function read() {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

function useOpen() {
  return useSyncExternalStore(subscribe, read, () => true);
}

/** Колонка с данными о диалоге — только на широком экране и если не скрыта кнопкой. */
export function InfoColumn({ children }: { children: ReactNode }) {
  const open = useOpen();
  if (!open) return null;
  return <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-border xl:block">{children}</aside>;
}

export function InfoToggle() {
  const { t } = useI18n();
  const open = useOpen();
  return (
    <button
      type="button"
      title={t.inbox.info}
      aria-pressed={open}
      onClick={() => {
        try {
          localStorage.setItem(KEY, open ? "0" : "1");
        } catch {}
        window.dispatchEvent(new Event(EVENT));
      }}
      className={cx(
        "hidden size-8 place-items-center rounded-lg transition xl:grid",
        open ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      <PanelRight className="size-4" />
    </button>
  );
}
