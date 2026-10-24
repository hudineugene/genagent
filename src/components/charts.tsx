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
    <div className="bg-metal rounded-2xl border p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-display text-2xl font-bold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/**
 * Плавный график-область одного ряда: линия по дням с мягкой заливкой, перекрестие и подсказка при наведении,
 * переключатель «таблица». Для счётных рядов (разговоры), где важна форма динамики.
 */
export function AreaChart({
  title,
  data,
  format = (v) => v.toLocaleString(),
  tableLabel,
  chartLabel,
  height = 180,
  integer,
}: {
  title: string;
  data: Column[];
  format?: (v: number) => string;
  tableLabel: string;
  chartLabel: string;
  height?: number;
  integer?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const top = Math.max(0, ...data.map((d) => d.value));
  const max = integer ? Math.max(4, Math.ceil(niceMax(top) / 4) * 4) : niceMax(top);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const W = 600;
  const n = Math.max(1, data.length - 1);
  const x = (i: number) => (i / n) * W;
  const y = (v: number) => height - (v / max) * (height - 6) - 1;
  // Сглаженная линия (кардинальный сплайн → кубические кривые)
  const pts = data.map((d, i) => [x(i), y(d.value)] as const);
  const line = pts
    .map((p, i) => {
      if (i === 0) return `M${p[0]},${p[1]}`;
      const p0 = pts[i - 2] ?? pts[i - 1];
      const p1 = pts[i - 1];
      const p3 = pts[i + 1] ?? p;
      const c1 = [p1[0] + (p[0] - p0[0]) / 6, p1[1] + (p[1] - p0[1]) / 6];
      const c2 = [p[0] - (p3[0] - p1[0]) / 6, p[1] - (p3[1] - p1[1]) / 6];
      return `C${c1[0]},${Math.min(height - 1, c1[1])} ${c2[0]},${Math.min(height - 1, c2[1])} ${p[0]},${p[1]}`;
    })
    .join(" ");
  const area = `${line} L${W},${height} L0,${height} Z`;
  const every = Math.max(1, Math.ceil(data.length / 8));
  const h = hover !== null ? data[hover] : null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button type="button" onClick={() => setTable(!table)} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text">
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
          <div className="relative w-12 shrink-0 text-right text-[11px] text-muted" style={{ height }}>
            {ticks.map((t) => (
              <span key={t} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ bottom: `${(t / max) * 100}%` }}>
                {format(t)}
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <div className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
              {ticks.map((t) => (
                <div key={t} className="absolute inset-x-0 border-t border-border" style={{ bottom: `${(t / max) * 100}%` }} />
              ))}
              <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
                <defs>
                  <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={area} fill="url(#area-fill)" />
                <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </svg>
              {/* Перекрестие и точка на наведённом дне */}
              {h && hover !== null && (
                <>
                  <div className="pointer-events-none absolute inset-y-0 w-px bg-accent/40" style={{ left: `${(hover / n) * 100}%` }} />
                  <div className="pointer-events-none absolute size-2.5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow" style={{ left: `${(hover / n) * 100}%`, bottom: `${(h.value / max) * 100}%` }} />
                  <div
                    className={cx("pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg", hover > data.length * 0.66 ? "-translate-x-full" : "")}
                    style={{ left: `calc(${(hover / n) * 100}% + ${hover > data.length * 0.66 ? -8 : 8}px)` }}
                  >
                    <div className="text-muted">{h.hint ?? h.label}</div>
                    <div className="font-semibold tabular-nums">{format(h.value)}</div>
                  </div>
                </>
              )}
              {/* Зоны наведения по дням */}
              <div className="absolute inset-0 flex">
                {data.map((d, i) => (
                  <div key={d.key} className="h-full flex-1" onMouseEnter={() => setHover(i)} />
                ))}
              </div>
            </div>
            <div className="mt-1.5 flex text-[11px] text-muted">
              {data.map((d, i) => (
                <div key={d.key} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
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
