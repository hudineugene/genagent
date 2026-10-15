"use client";

import { useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { clsx as cx } from "clsx";

const WIDTH = 288;
const MARGIN = 12;

/** Пояснение к полю — значок ⓘ рядом с названием: на компьютере по наведению, на телефоне по нажатию. */
export function InfoHint({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  // Не выходить за край экрана: сдвигаем окошко влево, если справа не помещается
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    setShift(Math.min(0, window.innerWidth - MARGIN - (r.left + width)));
  };
  return (
    <span
      ref={ref}
      className={cx("group/hint relative inline-flex align-middle", className)}
      onMouseEnter={place}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="?"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          place();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        className="grid size-5 place-items-center rounded-full text-muted/60 transition hover:text-text focus-visible:text-text"
      >
        <Info className="size-3.5" />
      </button>
      <span
        role="tooltip"
        style={{ left: shift, width: `min(${WIDTH}px, calc(100vw - ${MARGIN * 2}px))` }}
        className={cx(
          "absolute top-full z-40 mt-1 rounded-xl border border-border bg-surface p-3 text-xs leading-relaxed font-normal text-muted shadow-lg",
          open ? "block" : "hidden group-hover/hint:block",
        )}
      >
        {children}
      </span>
    </span>
  );
}
