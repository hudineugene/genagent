"use client";

import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, useTransition, type ComponentType } from "react";
import { Bot, CornerDownLeft, MessageCircle, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { searchAll, type SearchHit } from "@/app/actions/search";
import { ClientAvatar, Spinner, cx } from "./ui";

export type PalettePage = { href: string; label: string; icon: ComponentType<{ className?: string }> };

type Item = { key: string; group: string; href: string; title: string; subtitle?: string; lead: React.ReactNode };

/** Событие, которым кнопка поиска в меню открывает палитру. */
export const OPEN_PALETTE = "genagent:open-palette";

/**
 * Быстрый поиск (Ctrl K / ⌘K): разделы программы, клиенты, агенты и диалоги — переход с клавиатуры.
 * Пустой запрос показывает разделы, клиентов, агентов и свежие диалоги.
 */
export function CommandPalette({ pages }: { pages: PalettePage[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
    const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Открываем всегда с пустым запросом
    const show = () => {
      setQuery("");
      setActive(0);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          if (!v) {
            setQuery("");
            setActive(0);
          }
          return !v;
        });
      }
    };
    const onOpen = show;
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE, onOpen);
    };
  }, []);

  // Поиск с небольшой задержкой, пока человек печатает
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => start(async () => setHits(await searchAll(query))), query ? 150 : 0);
    return () => clearTimeout(timer);
  }, [open, query]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Item[] = pages
      .filter((p) => !q || p.label.toLowerCase().includes(q))
      .map((p) => ({ key: `p:${p.href}`, group: t.palette.pages, href: p.href, title: p.label, lead: <p.icon className="size-4 text-muted" /> }));
    for (const h of hits) {
      if (h.kind === "client") {
        out.push({ key: `c:${h.id}`, group: t.palette.clients, href: `/clients/${h.id}`, title: h.title, subtitle: h.subtitle, lead: <ClientAvatar name={h.title} color={h.color} size={24} /> });
      } else if (h.kind === "agent") {
        out.push({ key: `a:${h.id}`, group: t.palette.agents, href: `/agents/${h.id}`, title: h.title, subtitle: h.subtitle, lead: <span className="grid size-6 place-items-center text-base">{h.icon || <Bot className="size-4" />}</span> });
      } else {
        out.push({
          key: `d:${h.id}`,
          group: t.palette.conversations,
          href: `/inbox?c=${h.id}`,
          title: h.title,
          subtitle: h.subtitle,
          lead: (
            <span className="grid size-6 place-items-center rounded-full text-white" style={{ background: h.color }}>
              <MessageCircle className="size-3.5" />
            </span>
          ),
        });
      }
    }
    return out;
  }, [hits, pages, query, t]);

  const current = Math.min(active, items.length - 1);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (!open) return null;

  const go = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  };

  // В body: у меню размытие фона, а оно делает fixed-окно относительным к меню
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.nav.search}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/20"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          {pending ? <Spinner className="size-4 text-muted" /> : <Search className="size-4 text-muted" />}
          <input
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(Math.min(current + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(current - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(items[current]);
              }
            }}
            placeholder={t.palette.placeholder}
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted/70"
          />
          <kbd className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted">Esc</kbd>
        </div>
        <div ref={list} className="max-h-[60vh] overflow-y-auto p-2">
          {items.length === 0 && !pending && <p className="px-3 py-8 text-center text-sm text-muted">{t.palette.empty}</p>}
          {items.map((item, i) => (
            <div key={item.key}>
              {(i === 0 || items[i - 1].group !== item.group) && (
                <div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{item.group}</div>
              )}
              <button
                type="button"
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => go(item)}
                className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left", i === current ? "bg-accent-soft" : "hover:bg-surface-2")}
              >
                <span className="grid size-6 shrink-0 place-items-center">{item.lead}</span>
                <span className="min-w-0 flex-1">
                  <span className={cx("block truncate text-sm font-medium", i === current && "text-accent")}>{item.title}</span>
                  {item.subtitle && <span className="block truncate text-xs text-muted">{item.subtitle}</span>}
                </span>
                {i === current && <CornerDownLeft className="size-3.5 shrink-0 text-accent" />}
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] text-muted">{t.palette.hint}</div>
      </div>
    </div>,
    document.body,
  );
}
