import { TrendingDown, TrendingUp } from "lucide-react";

/** Мини-график ряда и стрелка тренда (последние 7 точек против предыдущих 7). Пустой ряд — ничего. */
export function Spark({ data, wide, height = 16 }: { data?: number[]; wide?: boolean; height?: number }) {
  if (!data || data.every((x) => x === 0)) return null;
  const w = wide ? 90 : 48;
  const h = height;
  const max = Math.max(1e-9, ...data);
  const pts = data.map((v, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const now = sum(data.slice(-7));
  const before = sum(data.slice(-14, -7));
  const up = now > before * 1.15 && now > 0;
  const down = now < before * 0.85;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="overflow-visible">
        <polyline points={pts} fill="none" strokeWidth={1.5} strokeLinejoin="round" className="stroke-accent/70" />
      </svg>
      {up && <TrendingUp className="size-3 text-success" />}
      {down && <TrendingDown className="size-3 text-danger" />}
    </span>
  );
}
