"use client";

import { useState } from "react";
import { cx } from "./ui";

/**
 * Карта активности: дни недели (строки, с понедельника) × часы (столбцы), насыщенность — сколько сообщений клиентов.
 * Наведение — точное число; под картой — пик и шкала «меньше → больше». Пусто — ничего не рисуем.
 */
export function Heatmap({ grid, days, title, hint, peakLabel, less, more, unit }: { grid: number[][]; days: string[]; title: string; hint: string; peakLabel: string; less: string; more: string; unit: string }) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const max = Math.max(0, ...grid.flat());
  if (max === 0) return null;
  let peak = { d: 0, h: 0, v: -1 };
  grid.forEach((row, d) => row.forEach((v, h) => v > peak.v && (peak = { d, h, v })));
  const level = (v: number) => (v === 0 ? 0 : Math.max(0.12, v / max));
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const cur = hover ? grid[hover.d][hover.h] : null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-muted tabular-nums" aria-live="polite">
          {hover ? `${days[hover.d]}, ${hh(hover.h)}–${hh((hover.h + 1) % 24)}: ${cur} ${unit}` : hint}
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[3px]" onMouseLeave={() => setHover(null)} role="img" aria-label={`${title}. ${peakLabel}: ${days[peak.d]}, ${hh(peak.h)}`}>
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center text-[11px] text-muted tabular-nums">
              {h % 3 === 0 ? h : ""}
            </span>
          ))}
          {grid.map((row, d) => (
            <div key={d} className="contents">
              <span className="self-center text-xs text-muted">{days[d]}</span>
              {row.map((v, h) => (
                <span
                  key={h}
                  onMouseEnter={() => setHover({ d, h })}
                  className={cx("aspect-square rounded-[3px] transition", hover?.d === d && hover?.h === h && "ring-2 ring-text/40")}
                  style={{ background: v ? `color-mix(in srgb, var(--accent) ${Math.round(level(v) * 100)}%, var(--surface-2))` : "var(--surface-2)" }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {peakLabel}: <b className="font-semibold text-text">{days[peak.d]}, {hh(peak.h)}–{hh((peak.h + 1) % 24)}</b> · {peak.v} {unit}
        </span>
        <span className="flex items-center gap-1.5">
          {less}
          {[0.12, 0.35, 0.6, 0.85, 1].map((l) => (
            <span key={l} className="size-3 rounded-[3px]" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(l * 100)}%, var(--surface-2))` }} />
          ))}
          {more}
        </span>
      </div>
    </div>
  );
}
