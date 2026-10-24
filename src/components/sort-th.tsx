import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cx } from "./ui";

export type SortDir = "asc" | "desc";

/** Сортировка из адреса: ?sort=ключ&dir=asc|desc (ключ — из разрешённых, иначе по умолчанию). */
export function readSort<K extends string>(sp: { sort?: string; dir?: string }, keys: readonly K[], fallback: K): { sort: K; dir: SortDir } {
  const sort = (keys as readonly string[]).includes(sp.sort ?? "") ? (sp.sort as K) : fallback;
  return { sort, dir: sp.dir === "asc" ? "asc" : "desc" };
}

/** Сравнение для сортировки: числа — по величине, строки — по алфавиту (с учётом языка). */
export function byKey<T>(get: (x: T) => number | string, dir: SortDir) {
  return (a: T, b: T) => {
    const x = get(a);
    const y = get(b);
    const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return dir === "asc" ? r : -r;
  };
}

/**
 * Заголовок столбца с сортировкой: щелчок — по этому столбцу (сначала по убыванию), повторный — в обратную сторону.
 * Состояние в адресе: ссылку можно переслать, «Назад» возвращает прежний порядок.
 */
export function SortTh({ label, col, sort, dir, href, align = "left", className }: { label: string; col: string; sort: string; dir: SortDir; href: (sort: string, dir: SortDir) => string; align?: "left" | "right"; className?: string }) {
  const active = sort === col;
  const next: SortDir = active && dir === "desc" ? "asc" : "desc";
  const Icon = !active ? ArrowUpDown : dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <th aria-sort={active ? (dir === "desc" ? "descending" : "ascending") : undefined} className={cx("py-2 pr-3 font-medium", align === "right" && "text-right", className)}>
      <Link
        href={href(col, next)}
        scroll={false}
        replace
        className={cx("group/sort inline-flex items-center gap-1 rounded transition hover:text-text", align === "right" && "flex-row-reverse", active && "text-text")}
      >
        {label}
        <Icon className={cx("size-3 shrink-0", active ? "text-accent" : "opacity-0 group-hover/sort:opacity-60")} />
      </Link>
    </th>
  );
}
