"use client";

import { useState } from "react";
import { cx } from "./ui";

export type Column = { key: string; label: string; value: number; hint?: string };

/** «Красивый» верх оси: 1, 2, 2.5, 5 × 10^n — деления читаются без усилий. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/**
 * Столбчатая диаграмма одного ряда (без легенды — что показано, говорит заголовок).
 * Столбцы ≤24px со скруглённым верхом, тонкая сетка, подсказка при наведении на всю высоту столбца,
 * переключатель «таблица» — те же данные без графика.
 */
export function ColumnChart({
  title,
  data,
  format = (v) => v.toLocaleString(),
  tableLabel,
  chartLabel,
  height = 180,
  labelEvery,
  integer,
}: {
  title: string;
  data: Column[];
  format?: (v: number) => string;
  tableLabel: string;
  chartLabel: string;
  height?: number;
  /** Подписывать каждую n-ю метку оси X (чтобы не слипались) */
  labelEvery?: number;
  /** Значения — штуки: деления оси только целые */
  integer?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const top = Math.max(0, ...data.map((d) => d.value));
  const max = integer ? Math.max(4, Math.ceil(niceMax(top) / 4) * 4) : niceMax(top);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = labelEvery ?? Math.max(1, Math.ceil(data.length / 8));

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button
          type="button"
          onClick={() => setTable(!table)}
          className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
        >
          {table ? chartLabel : tableLabel}
        </button>
      </div>

      {table ? (
        <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <tbody>
              {data.map((d) => (
                <tr key={d.key} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-muted">{d.hint ?? d.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{format(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex gap-2 pt-2">
          {/* ось Y */}
          <div className="relative w-12 shrink-0 text-right text-[11px] text-muted" style={{ height }}>
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ bottom: `${(t / max) * 100}%` }}>
                {format(t)}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="relative" style={{ height }}>
              {/* сетка — волосяные линии на шаг светлее поверхности */}
              {ticks.map((t) => (
                <div key={t} className="absolute inset-x-0 border-t border-border" style={{ bottom: `${(t / max) * 100}%` }} />
              ))}
              <div className="absolute inset-0 flex items-end gap-[2px]">
                {data.map((d, i) => (
                  <div
                    key={d.key}
                    className="relative flex h-full min-w-0 flex-1 items-end justify-center"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div
                      className={cx("w-full max-w-6 rounded-t-[4px] bg-accent transition-opacity", hover !== null && hover !== i && "opacity-40")}
                      style={{ height: d.value > 0 ? `max(${(d.value / max) * 100}%, 2px)` : 0 }}
                    />
                    {hover === i && (
                      <div
                        className={cx(
                          "pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg",
                          i < data.length / 3 ? "left-0" : i > (data.length * 2) / 3 ? "right-0" : "left-1/2 -translate-x-1/2",
                        )}
                      >
                        <div className="text-muted">{d.hint ?? d.label}</div>
                        <div className="font-semibold tabular-nums">{format(d.value)}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* ось X */}
            <div className="mt-1.5 flex gap-[2px] text-[11px] text-muted">
              {data.map((d, i) => (
                <div key={d.key} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
                  {i % every === 0 ? d.label : ""}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Плитка показателя: подпись, значение, необязательное пояснение. */
export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}
