"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  BarChart3,
  Building2,
  CircleHelp,
  House,
  LayoutTemplate,
  LogOut,
  MessagesSquare,
  Monitor,
  MoreHorizontal,
  Moon,
  Plug,
  SlidersHorizontal,
  Search,
  Sun,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n";
import { logout, setLocale } from "@/app/actions/auth";
import { CommandPalette, OPEN_PALETTE, type PalettePage } from "./command-palette";
import { cx } from "./ui";
import { BrandMark } from "./brand";

type NavItem = PalettePage & { active: boolean; badge?: number };

export function Sidebar({ userName, isAdmin, inboxBadge, studioName }: { userName: string; isAdmin: boolean; inboxBadge: number; studioName?: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const work: NavItem[] = [
    { href: "/", label: t.nav.today, icon: House, active: pathname === "/" },
    { href: "/inbox", label: t.nav.inbox, icon: MessagesSquare, active: pathname.startsWith("/inbox"), badge: inboxBadge },
    {
      href: "/clients",
      label: t.nav.clients,
      icon: Building2,
      active: pathname.startsWith("/clients") || pathname.startsWith("/agents"),
    },
    { href: "/analytics", label: t.nav.analytics, icon: BarChart3, active: pathname.startsWith("/analytics") },
    { href: "/templates", label: t.nav.templates, icon: LayoutTemplate, active: pathname.startsWith("/templates") },
  ];
  const settings: NavItem[] = isAdmin
    ? [
        { href: "/team", label: t.nav.team, icon: Users, active: pathname.startsWith("/team") },
        { href: "/billing", label: t.nav.billing, icon: Wallet, active: pathname.startsWith("/billing") },
        { href: "/integrations", label: t.nav.integrations, icon: Plug, active: pathname.startsWith("/integrations") },
        { href: "/settings", label: t.nav.settings, icon: SlidersHorizontal, active: pathname.startsWith("/settings") },
      ]
    : [];
  const help: NavItem[] = [{ href: "/help", label: t.nav.help, icon: CircleHelp, active: pathname.startsWith("/help") }];
  const openSearch = () => window.dispatchEvent(new Event(OPEN_PALETTE));

  return (
    <aside className="z-30 flex shrink-0 items-center gap-2 border-b border-border bg-surface/90 px-3 py-2.5 backdrop-blur md:sticky md:top-0 md:h-dvh md:w-60 md:flex-col md:items-stretch md:gap-1 md:border-r md:border-b-0 md:bg-surface md:px-3 md:py-4">
      <CommandPalette pages={[...work, ...settings, ...help, { href: "/profile", label: t.nav.profile, icon: UserRound }]} />

      <Link href="/" className="flex shrink-0 items-center gap-2.5 md:mb-4 md:px-2">
        <BrandMark size={32} />
        <span className="hidden truncate font-semibold tracking-tight md:block">{studioName || t.app.name}</span>
      </Link>

      {/* Поиск: на телефоне — иконка, на компьютере — поле с подсказкой Ctrl K */}
      <button
        type="button"
        onClick={openSearch}
        title={`${t.nav.search} (Ctrl K)`}
        className="order-last ml-auto grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-text md:order-none md:mb-3 md:ml-0 md:flex md:h-9 md:w-full md:items-center md:gap-2.5 md:border md:border-border md:bg-surface-2/60 md:px-3 md:text-sm"
      >
        <Search className="size-4" />
        <span className="hidden flex-1 text-left md:inline">{t.nav.search}</span>
        <kbd className="hidden rounded-md border border-border bg-surface px-1.5 text-[11px] font-medium md:inline">Ctrl K</kbd>
      </button>

      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] md:flex-col md:items-stretch md:gap-2 md:overflow-visible md:[&>div+div]:border-t md:[&>div+div]:border-border md:[&>div+div]:pt-2">
        <NavGroup items={work} />
        {settings.length > 0 && <NavGroup items={settings} />}
        <NavGroup items={help} />
      </nav>

      {/* Телефон: профиль (там же язык и выход) — аватаром в конце строки */}
      <Link
        href="/profile"
        title={t.nav.profile}
        className="order-last grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent md:hidden"
      >
        {userName.trim().charAt(0).toUpperCase() || "?"}
      </Link>

      {/* Компьютер: внизу — профиль; язык, тема и выход — в меню «⋯» */}
      <div className="relative hidden items-center gap-1 md:flex md:border-t md:border-border md:pt-3">
        <Link
          href="/profile"
          className={cx(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-1.5 transition hover:bg-surface-2",
            pathname.startsWith("/profile") && "bg-surface-2",
          )}
          title={t.nav.profile}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
            {userName.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <span className="truncate text-sm font-medium">{userName}</span>
        </Link>
        <ProfileMenu />
      </div>
    </aside>
  );
}

/** Меню «⋯» у профиля: язык, тема, выход. Закрывается кликом мимо и Esc. */
function ProfileMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t.nav.groupSettings}
        className={cx("grid size-9 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-text", open && "bg-surface-2 text-text")}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full left-0 mb-2 space-y-3 rounded-2xl border border-border bg-surface p-3 shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{t.nav.language}</span>
            <LocaleSwitch />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{t.nav.theme}</span>
            <ThemeSwitch />
          </div>
          <form action={logout} className="border-t border-border pt-2">
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted transition hover:bg-surface-2 hover:text-danger">
              <LogOut className="size-4" />
              {t.nav.logout}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function NavGroup({ items }: { items: NavItem[] }) {
  return (
    <div className="flex gap-0.5 md:flex-col">
      {items.map(({ href, label, icon: Icon, active, badge }) => (
        <Link
          key={href}
          href={href}
          title={label}
          className={cx(
            "relative flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition",
            active ? "bg-surface-2 text-text [&_svg]:text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          <span className="relative">
            <Icon className="size-4" />
            {badge ? (
              <span className="absolute -top-1.5 -right-2 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white md:hidden">{badge}</span>
            ) : null}
          </span>
          <span className="hidden md:inline">{label}</span>
          {badge ? (
            <span className="ml-auto hidden min-w-5 rounded-full bg-danger px-1.5 text-center text-xs leading-5 font-semibold text-white md:inline">{badge}</span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

export function LocaleSwitch() {
  const { locale, t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div className={cx("inline-flex rounded-xl bg-surface-2 p-1 text-xs font-semibold", pending && "opacity-60")} role="group" aria-label={t.nav.language}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => start(() => setLocale(l))}
          className={cx("rounded-lg px-2.5 py-1 transition", l === locale ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

type Theme = "light" | "dark" | "system";
const THEME_EVENT = "genagent:theme";

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function subscribeTheme(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Светлая / тёмная / как в системе — выбор хранится в браузере (скрипт в layout применяет его до отрисовки). */
export function ThemeSwitch() {
  const { t } = useI18n();
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "system" as Theme);
  const pick = (next: Theme) => {
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {}
    (window as unknown as { __applyTheme?: () => void }).__applyTheme?.();
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t.nav.themeLight, icon: Sun },
    { value: "dark", label: t.nav.themeDark, icon: Moon },
    { value: "system", label: t.nav.themeSystem, icon: Monitor },
  ];
  return (
    <div className="inline-flex rounded-xl bg-surface-2 p-1" role="group" aria-label={t.nav.theme}>
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-pressed={theme === value}
          onClick={() => pick(value)}
          className={cx("grid size-6 place-items-center rounded-lg transition", theme === value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
