"use client";

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "./ui";

type Tone = "success" | "error" | "info";
type Item = { id: number; text: string; tone: Tone };

const EVENT = "genagent:toast";

/** Всплывающее уведомление в углу экрана: «Сохранено», «Не удалось…» — без надписей посреди страницы. */
export function toast(text: string, tone: Tone = "success") {
  window.dispatchEvent(new CustomEvent<{ text: string; tone: Tone }>(EVENT, { detail: { text, tone } }));
}

const LOOK: Record<Tone, { icon: typeof Info; cls: string }> = {
  success: { icon: CircleCheck, cls: "text-success" },
  error: { icon: CircleAlert, cls: "text-danger" },
  info: { icon: Info, cls: "text-accent" },
};

/** Стопка уведомлений (одна на программу, в каркасе). Каждое исчезает само через 4 с (ошибка — через 7 с). */
export function Toaster() {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let seq = 0;
    const on = (e: Event) => {
      const { text, tone } = (e as CustomEvent<{ text: string; tone: Tone }>).detail;
      const id = ++seq;
      setItems((list) => [...list.slice(-3), { id, text, tone }]);
      setTimeout(() => setItems((list) => list.filter((x) => x.id !== id)), tone === "error" ? 7000 : 4000);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-3 bottom-20 z-[60] flex flex-col items-center gap-2 md:inset-x-auto md:right-5 md:bottom-5 md:items-end">
      {items.map(({ id, text, tone }) => {
        const { icon: Icon, cls } = LOOK[tone];
        return (
          <div
            key={id}
            role={tone === "error" ? "alert" : "status"}
            className="animate-toast-in pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-xl border border-border bg-surface py-2.5 pr-2 pl-3 text-sm shadow-xl shadow-black/10"
          >
            <Icon className={cx("mt-0.5 size-4 shrink-0", cls)} />
            <span className="min-w-0 flex-1">{text}</span>
            <button type="button" aria-label={t.shell.close} onClick={() => setItems((list) => list.filter((x) => x.id !== id))} className="grid size-5 shrink-0 place-items-center rounded text-muted hover:text-text">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
