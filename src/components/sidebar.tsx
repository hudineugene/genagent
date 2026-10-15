"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore, useTransition } from "react";
import {
  BarChart3,
  Building2,
  House,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  Plug,
  Search,
  Sparkles,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n";
import { logout, setLocale } from "@/app/actions/auth";
import { CommandPalette, OPEN_PALETTE, type PalettePage } from "./command-palette";
import { cx } from "./ui";

type NavItem = PalettePage & { active: boolean; badge?: number };

export function Sidebar({ userName, isAdmin, inboxBadge }: { userName: string; isAdmin: boolean; inboxBadge: number }) {
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
  ];
  const settings: NavItem[] = isAdmin
    ? [
        { href: "/team", label: t.nav.team, icon: Users, active: pathname.startsWith("/team") },
        { href: "/integrations", label: t.nav.integrations, icon: Plug, active: pathname.startsWith("/integrations") },
      ]
    : [];
  const openSearch = () => window.dispatchEvent(new Event(OPEN_PALETTE));

  return (
    <aside className="z-30 flex shrink-0 items-center gap-2 border-b border-border bg-surface/90 px-3 py-2.5 backdrop-blur md:sticky md:top-0 md:h-dvh md:w-64 md:flex-col md:items-stretch md:gap-1 md:border-r md:border-b-0 md:bg-surface md:px-3 md:py-5">
      <CommandPalette pages={[...work, ...settings, { href: "/profile", label: t.nav.profile, icon: UserRound }]} />

      <Link href="/" className="flex shrink-0 items-center gap-2.5 md:mb-5 md:px-2">
        <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-violet-500 text-accent-text shadow-md shadow-accent/25">
          <Sparkles className="size-5" />
        </span>
        <span className="hidden leading-tight md:block">
          <span className="block font-semibold tracking-tight">{t.app.name}</span>
          <span className="block text-xs text-muted">{t.app.tagline}</span>
        </span>
      </Link>

      {/* Поиск: на телефоне — иконка, на компьютере — поле с подсказкой Ctrl K */}
      <button
        type="button"
        onClick={openSearch}
        title={`${t.nav.search} (Ctrl K)`}
        className="order-last ml-auto grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-text md:order-none md:mb-4 md:ml-0 md:flex md:h-10 md:w-full md:items-center md:gap-2.5 md:border md:border-border md:bg-surface-2/60 md:px-3 md:text-sm"
      >
        <Search className="size-4" />
        <span className="hidden flex-1 text-left md:inline">{t.nav.search}</span>
        <kbd className="hidden rounded-md border border-border bg-surface px-1.5 text-[11px] font-medium md:inline">Ctrl K</kbd>
      </button>

      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] md:flex-col md:items-stretch md:gap-5 md:overflow-visible">
        <NavGroup title={t.nav.groupWork} items={work} />
        {settings.length > 0 && <NavGroup title={t.nav.groupSettings} items={settings} />}
      </nav>

      {/* Телефон: профиль (там же язык и выход) — аватаром в конце строки */}
      <Link
        href="/profile"
        title={t.nav.profile}
        className="order-last grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent md:hidden"
      >
        {userName.trim().charAt(0).toUpperCase() || "?"}
      </Link>

      <div className="hidden md:block md:space-y-3 md:border-t md:border-border md:pt-4">
        <div className="flex items-center justify-between gap-1.5 px-1">
          <LocaleSwitch />
          <ThemeSwitch />
        </div>
        <div className="flex items-center gap-1">
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
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-medium">{userName}</span>
              <span className="block truncate text-xs text-muted">{t.nav.profile}</span>
            </span>
          </Link>
          <form action={logout}>
            <button className="grid size-9 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-danger" title={t.nav.logout}>
              <LogOut className="size-4" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

function NavGroup({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <div className="flex gap-0.5 md:flex-col">
      <div className="hidden px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-muted/80 uppercase md:block">{title}</div>
      {items.map(({ href, label, icon: Icon, active, badge }) => (
        <Link
          key={href}
          href={href}
          title={label}
          className={cx(
            "relative flex shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium transition md:px-3",
            active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          {active && <span className="absolute top-2 bottom-2 -left-3 hidden w-1 rounded-r-full bg-accent md:block" />}
          <span className="relative">
            <Icon className="size-[18px]" />
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
