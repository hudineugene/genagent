"use client";

import { useEffect, useRef, useState } from "react";

/**
 * «Живая» цифра: число в строке («$6.38», «17%», «1 234») плавно набегает при появлении и при смене значения.
 * Анимации выключены в системе или в строке нет числа — показывается как есть.
 */
export function CountUp({ value, className }: { value: string | number; className?: string }) {
  const text = String(value);
  const m = text.match(/^(\D*?)(-?\d(?:[\d\s\u00a0]*\d)?(?:[.,]\d+)?)([\s\S]*)$/);
  const target = m ? Number(m[2].replace(/[\s\u00a0]/g, "").replace(",", ".")) : NaN;
  const decimals = m && /[.,](\d+)$/.test(m[2]) ? m[2].split(/[.,]/)[1].length : 0;
  const grouped = m ? /[\s\u00a0]/.test(m[2]) : false;
  const [shown, setShown] = useState<number | null>(null);
  const from = useRef(0);
  useEffect(() => {
    if (!Number.isFinite(target) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 700);
      const eased = 1 - (1 - k) ** 3;
      setShown(a + (target - a) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!m || shown === null || !Number.isFinite(target)) return <span className={className}>{text}</span>;
  const num = grouped ? shown.toLocaleString("ru-RU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : shown.toFixed(decimals).replace(".", m[2].includes(",") ? "," : ".");
  return (
    <span className={className} aria-label={text}>
      {m[1]}
      {num}
      {m[3]}
    </span>
  );
}
