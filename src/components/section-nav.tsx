"use client";

import { useEffect, useState } from "react";
import { cx } from "./ui";

/**
 * Оглавление длинной страницы настроек (компьютер): ссылки на разделы, текущий подсвечивается при прокрутке.
 * Разделы — элементы с id из items.
 */
export function SectionNav({ items, label }: { items: { id: string; label: string }[]; label: string }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  useEffect(() => {
    // Текущий — последний раздел, чей верх уже под верхней строкой (или первый, пока не прокрутили)
    const pick = () => {
      let cur = items[0]?.id ?? "";
      for (const i of items) {
        const top = document.getElementById(i.id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= 170) cur = i.id;
      }
      // Долистали до конца — последний раздел
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = items[items.length - 1]?.id ?? cur;
      setActive(cur);
    };
    pick();
    window.addEventListener("scroll", pick, { passive: true });
    return () => window.removeEventListener("scroll", pick);
  }, [items]);
  return (
    <nav aria-label={label} className="sticky top-20 hidden self-start lg:block">
      <ul className="space-y-0.5 border-l border-border">
        {items.map((i) => (
          <li key={i.id}>
            <a
              href={`#${i.id}`}
              aria-current={active === i.id ? "location" : undefined}
              className={cx("-ml-px block border-l-2 py-1.5 pl-3.5 text-sm transition", active === i.id ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text")}
            >
              {i.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
