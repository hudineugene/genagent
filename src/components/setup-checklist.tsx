"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowRight, ChevronDown, ListChecks, X } from "lucide-react";
import { dismissSetupAction } from "@/app/actions/setup";
import { useI18n } from "@/lib/i18n/client";
import { Card, cx } from "@/components/ui";

export type SetupView = { key: string; kind: string; title: string; n?: number; href: string };

/** Что ещё не настроено: пункт → ссылка туда, где включается; «Не нужно» — скрыть пункт насовсем.
 *  compact (страница агента) — свёрнуто в одну строку, раскрывается по нажатию. */
export function SetupChecklist({ items, compact = false }: { items: SetupView[]; compact?: boolean }) {
  const { t } = useI18n();
  const s = t.setup;
  const [hidden, setHidden] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(!compact);
  const list = items.filter((i) => !hidden.includes(i.key));
  if (!list.length) return null;
  const text = (i: SetupView) => (s.items[i.kind as keyof typeof s.items] ?? i.kind).replace("{n}", String(i.n ?? ""));
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cx("flex w-full items-center gap-2 px-4 py-2.5 text-left", open && "border-b border-border")}
      >
        <ListChecks className="size-4 text-accent" />
        <span className="text-sm font-semibold">{s.title}</span>
        <span className="rounded-full bg-amber-500/12 px-2 text-xs font-medium text-amber-600 dark:text-amber-400">{list.length}</span>
        {!compact && <span className="ml-auto hidden text-xs text-muted sm:block">{s.hint}</span>}
        <ChevronDown className={cx("size-4 text-muted transition", compact && "ml-auto", open && "rotate-180")} />
      </button>
      {open && (
      <ul className="divide-y divide-border">
        {list.map((i, idx) => (
          <li key={i.key} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1">
              {/* Пункты одного агента идут подряд — название агента над первым */}
              {i.title && !compact && i.title !== list[idx - 1]?.title && <span className="mb-0.5 block truncate text-xs font-medium text-muted">{i.title}</span>}
              <span className="block">{text(i)}</span>
            </span>
            <Link href={i.href} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline">
              {s.open}
              <ArrowRight className="size-3" />
            </Link>
            <button
              type="button"
              title={s.dismiss}
              disabled={pending}
              className="shrink-0 rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
              onClick={() => {
                setHidden((h) => [...h, i.key]);
                start(() => dismissSetupAction(i.key));
              }}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      )}
    </Card>
  );
}
