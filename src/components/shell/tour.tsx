"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "../ui";

/** Событие, которым поиск (действие «Показать тур») запускает тур заново. */
export const START_TOUR = "genagent:tour";
const DONE_KEY = "tour-menu-v1";
/** Шаги тура — элементы с data-tour по порядку; невидимые (свёрнутая панель) пропускаются. */
const TARGETS = ["rail", "panel", "search", "bell", "profile"];

type Box = { top: number; left: number; width: number; height: number };

/**
 * Короткий тур по меню при первом входе (компьютер): подсветка элемента и подсказка рядом. Пройден или пропущен —
 * больше не показывается в этом браузере; снова — из поиска «Показать тур по меню».
 */
export function Tour() {
  const { t } = useI18n();
  const [step, setStep] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    let done = true;
    try {
      done = localStorage.getItem(DONE_KEY) === "1";
    } catch {}
    const timer = !done && window.matchMedia("(min-width: 768px)").matches ? setTimeout(() => setStep(0), 1200) : undefined;
    const start = () => setStep(0);
    window.addEventListener(START_TOUR, start);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(START_TOUR, start);
    };
  }, []);

  // Позиция подсвеченного элемента; невидимый шаг — дальше
  useLayoutEffect(() => {
    if (step === null) return;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${TARGETS[step]}"]`);
      const r = el?.getBoundingClientRect();
      if (!r || r.width === 0) {
        setStep((s) => (s !== null && s + 1 < TARGETS.length ? s + 1 : null));
        return;
      }
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step]);

  if (step === null || !box) return null;
  const finish = () => {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {}
    setStep(null);
    setBox(null);
  };
  const last = step === TARGETS.length - 1;
  const info = t.tour.steps[step];
  const pad = 6;
  // Подсказка справа от узких элементов (рельса, панель), иначе — под элементом
  const right = box.width < 300 && box.left + box.width + 340 < window.innerWidth;
  const tip = right
    ? { top: Math.min(Math.max(12, box.top), window.innerHeight - 220), left: box.left + box.width + 16 }
    : { top: box.top + box.height + 14, left: Math.min(Math.max(12, box.left + box.width - 320), window.innerWidth - 332) };
  return createPortal(
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={info.title}>
      <div
        className="pointer-events-none absolute rounded-xl ring-2 ring-accent transition-all duration-300"
        style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.5)" }}
      />
      <div key={step} className="animate-pop-in absolute w-80 rounded-2xl border border-border bg-surface p-4 shadow-2xl" style={tip}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">{info.title}</h2>
          <span className="text-xs text-muted tabular-nums">
            {step + 1} / {TARGETS.length}
          </span>
        </div>
        <p className="text-sm text-muted">{info.text}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button type="button" onClick={finish} className="text-xs text-muted hover:text-text">
            {t.tour.skip}
          </button>
          <Button size="sm" autoFocus onClick={() => (last ? finish() : setStep(step + 1))}>
            {last ? t.tour.done : t.tour.next}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
