"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { Bell, ChevronRight, CircleDollarSign, Flame, Hand, MessagesSquare, Moon, Search, Sun } from "lucide-react";
import { bellFeed, type NavCtx } from "@/app/actions/nav";
import type { FeedItem } from "@/lib/home-live";
import type { Dict } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { OPEN_PALETTE } from "../command-palette";
import { cx } from "../ui";
import { useShell } from "./frame";
import { RelTime } from "../rel-time";
import { rememberPage } from "./recent";
import { chime, notifyOn } from "./notify";

/** Верхняя строка (компьютер): путь к странице, поиск, события и тема. Липкая — всегда под рукой. */
export function Topbar() {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-20 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-bg/85 px-6 backdrop-blur-md md:flex lg:px-8">
      <Suspense fallback={<span className="flex-1" />}>
        <Crumbs />
      </Suspense>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))}
        data-tour="search"
        className="flex h-9 w-56 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-sm text-muted transition hover:border-accent/40 hover:text-text xl:w-72"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">{t.nav.search}</span>
        <kbd className="rounded-md border border-border bg-surface-2 px-1.5 text-[11px] font-medium">Ctrl K</kbd>
      </button>
      <BellMenu />
      <ThemeToggle />
    </header>
  );
}

type Crumb = { label: string; href?: string };

const TOP: Record<string, keyof Dict["nav"]> = {
  inbox: "inbox",
  clients: "clients",
  analytics: "analytics",
  templates: "templates",
  team: "team",
  billing: "billing",
  integrations: "integrations",
  settings: "settings",
  help: "help",
  profile: "profile",
};

/** Путь «Клиенты › АНКОР › Помічник › Карта»: имена — из данных панели, разделы — из словаря. */
function crumbs(pathname: string, tab: string | null, ctx: NavCtx | null, t: Dict): Crumb[] {
  const seg = pathname.split("/").filter(Boolean);
  if (seg.length === 0) return [{ label: t.nav.today }];
  const clientsCrumb = { label: t.nav.clients, href: "/clients" };
  if (seg[0] === "agents" && seg[1]) {
    const a = ctx?.kind === "agent" && ctx.agent.id === seg[1] ? ctx : null;
    const sub: Record<string, string> = { map: t.help.mapTab, channels: t.channels.tab, tests: t.tests.tab, gaps: t.gaps.tab, review: t.review.tab };
    return [
      clientsCrumb,
      { label: a?.client.name ?? "…", href: a ? `/clients/${a.client.id}` : undefined },
      { label: a?.agent.name ?? "…", href: seg[2] ? `/agents/${seg[1]}` : undefined },
      ...(seg[2] && sub[seg[2]] ? [{ label: sub[seg[2]] }] : []),
    ];
  }
  if (seg[0] === "clients" && seg[1]) {
    if (seg[1] === "new") return [clientsCrumb, { label: t.shell.newClient }];
    const c = ctx?.kind === "client" && ctx.client.id === seg[1] ? ctx : null;
    const base = `/clients/${seg[1]}`;
    const deep = seg[2] === "edit" ? t.client.settings : seg[2] === "agents" && seg[3] === "new" ? t.shell.newAgent : null;
    const section = !seg[2] && tab && tab !== "agents" ? c?.nav.flatMap((g) => g.items).find((i) => i.key === tab)?.label : null;
    const last = deep ?? section;
    return [clientsCrumb, { label: c?.client.name ?? "…", href: last ? base : undefined }, ...(last ? [{ label: last }] : [])];
  }
  const key = TOP[seg[0]];
  return key ? [{ label: t.nav[key], href: seg.length > 1 ? `/${seg[0]}` : undefined }] : [];
}

function Crumbs() {
  const { t } = useI18n();
  const { ctx, ctxPath } = useShell();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  // Данные для адреса пришли, а имени нет (запись не найдена) — звено «…» убираем
  const list = crumbs(pathname, tab, ctx, t).filter((c) => c.label !== "…" || ctxPath !== pathname);
  const title = list.map((c) => c.label).join(" › ");
  const href = pathname + (tab ? `?tab=${tab}` : "");
  // Страница с известными именами — в «Недавние» поиска
  useEffect(() => {
    if (title && !title.includes("…")) rememberPage({ href, title });
  }, [href, title]);
  // Заголовок вкладки браузера: «(7) Карта · Консультант YABOT — GenAgent»; число — разговоры, ждущие человека
  const waiting = ctx?.clients.reduce((a, c) => a + c.waiting, 0) ?? 0;
  const tabTitle = list
    .slice(-2)
    .reverse()
    .map((c) => c.label)
    .filter((x) => x !== "…")
    .join(" · ");
  useEffect(() => {
    document.title = `${waiting ? `(${waiting}) ` : ""}${tabTitle ? `${tabTitle} — ` : ""}GenAgent`;
    setFaviconDot(waiting > 0);
  }, [tabTitle, waiting]);
  return (
    <nav aria-label={t.shell.path} className="flex min-w-0 flex-1 items-center gap-1 text-sm">
      {list.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted/60" />}
          {c.href ? (
            <Link href={c.href} className="truncate rounded-md px-1.5 py-0.5 text-muted transition hover:bg-surface-2 hover:text-text">
              {c.label}
            </Link>
          ) : (
            <span className={cx("truncate px-1.5 py-0.5", i === list.length - 1 ? "font-medium text-text" : "text-muted")} aria-current={i === list.length - 1 ? "page" : undefined}>
              {c.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

/** Значок вкладки: красная точка, когда кто-то ждёт человека (рисуется поверх знака на холсте). */
let faviconBase: string | null = null;
let faviconDot: boolean | null = null;
function setFaviconDot(on: boolean) {
  if (faviconDot === on) return;
  faviconDot = on;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  faviconBase ??= link.href;
  if (!on) {
    link.href = faviconBase;
    return;
  }
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g || !faviconDot) return;
    g.drawImage(img, 0, 0, 64, 64);
    g.beginPath();
    g.arc(50, 14, 12, 0, Math.PI * 2);
    g.fillStyle = "#e11d48";
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#ffffff";
    g.stroke();
    link.href = c.toDataURL("image/png");
  };
  img.src = faviconBase;
}

const SEEN_KEY = "bell-seen";


/** Колокольчик: события за 3 дня; точка — есть новые с прошлого открытия. Обновляется раз в минуту. */
function BellMenu() {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [seen, setSeen] = useState(Number.POSITIVE_INFINITY);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    // Уведомлять только о событиях после открытия страницы
    let since = Date.now();
    const load = () =>
      bellFeed()
        .then((list) => {
          if (!alive) return;
          setItems(list);
          const important = list.filter((x) => (x.kind === "handoff" || x.kind === "hot") && x.at > since);
          if (important.length && notifyOn()) {
            chime();
            for (const f of important.slice(0, 3)) {
              const n = new Notification(f.kind === "hot" ? t.home.feedHot : t.home.feedHandoff, { body: [f.client, f.contact].filter(Boolean).join(" · "), tag: `${f.kind}-${f.conversationId}` });
              n.onclick = () => {
                window.focus();
                if (f.conversationId) router.push(`/inbox?c=${f.conversationId}`);
              };
            }
          }
          since = Math.max(since, ...list.map((x) => x.at));
          try {
            setSeen(Number(localStorage.getItem(SEEN_KEY) ?? 0));
          } catch {
            setSeen(0);
          }
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [t, router]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const fresh = items.filter((x) => x.at > seen).length;
  const toggle = () => {
    if (!open) {
      const now = Date.now();
      try {
        localStorage.setItem(SEEN_KEY, String(now));
      } catch {}
      setSeen(now);
    }
    setOpen((v) => !v);
  };
  const look = {
    new: { icon: MessagesSquare, cls: "bg-accent-soft text-accent", text: t.home.feedNew },
    handoff: { icon: Hand, cls: "bg-amber-500/12 text-amber-600 dark:text-amber-400", text: t.home.feedHandoff },
    hot: { icon: Flame, cls: "bg-danger/10 text-danger", text: t.home.feedHot },
    paid: { icon: CircleDollarSign, cls: "bg-success/10 text-success", text: t.home.feedPaid },
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={t.shell.events}
        title={t.shell.events}
        data-tour="bell"
        className={cx("relative grid size-9 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-text", open && "bg-surface-2 text-text")}
      >
        <Bell className="size-[18px]" />
        {fresh > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger ring-2 ring-bg" />}
      </button>
      {open && (
        <div className="animate-pop-in absolute top-full right-0 z-50 mt-2 w-[22rem] overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/15">
          <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">{t.shell.events}</div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">{t.shell.eventsEmpty}</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {items.map((f, i) => {
                const l = look[f.kind];
                const body = (
                  <span className="flex items-center gap-3 px-4 py-2.5">
                    <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg", l.cls)}>
                      <l.icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {l.text}
                        {f.amount ? ` · ${f.amount}` : f.contact ? ` · ${f.contact}` : ""}
                      </span>
                      <span className="flex items-center gap-1.5 truncate text-xs text-muted">
                        <span className="size-1.5 shrink-0 rounded-full" style={{ background: f.color }} />
                        {f.client}
                      </span>
                    </span>
                    <RelTime at={f.at} className="shrink-0 text-xs text-muted" />
                  </span>
                );
                return (
                  <li key={`${f.kind}-${f.conversationId}-${f.at}-${i}`}>
                    {f.conversationId ? (
                      <Link href={`/inbox?c=${f.conversationId}`} onClick={() => setOpen(false)} className="block transition hover:bg-surface-2/60">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Link href="/" onClick={() => setOpen(false)} className="block border-t border-border px-4 py-2.5 text-center text-sm font-medium text-accent hover:bg-surface-2/60">
            {t.shell.allEvents}
          </Link>
        </div>
      )}
    </div>
  );
}

/** Быстрая смена темы: светлая ⇄ тёмная (подробный выбор, включая «как в системе», — в меню профиля). */
function ThemeToggle() {
  const { t } = useI18n();
  const flip = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("theme", next);
    } catch {}
    (window as unknown as { __applyTheme?: () => void }).__applyTheme?.();
    window.dispatchEvent(new Event("genagent:theme"));
  };
  return (
    <button type="button" onClick={flip} aria-label={t.shell.themeToggle} title={t.shell.themeToggle} className="grid size-9 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-text">
      <Moon className="size-[18px] dark:hidden" />
      <Sun className="hidden size-[18px] dark:block" />
    </button>
  );
}
