"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
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
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Rows3,
  Rows4,
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
import {
  CommandPalette,
  OPEN_PALETTE,
  type PalettePage,
} from "./command-palette";
import { cx } from "./ui";
import { BrandMark } from "./brand";
import { useShell } from "./shell/frame";

type NavItem = PalettePage & { active: boolean; badge?: number };

export function Sidebar({
  userName,
  isAdmin,
  inboxBadge,
}: {
  userName: string;
  isAdmin: boolean;
  inboxBadge: number;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { panel, togglePanel } = useShell();
  const work: NavItem[] = [
    { href: "/", label: t.nav.today, icon: House, active: pathname === "/" },
    { href: "/inbox", label: t.nav.inbox, icon: MessagesSquare, active: pathname.startsWith("/inbox"), badge: inboxBadge },
    { href: "/clients", label: t.nav.clients, icon: Building2, active: pathname.startsWith("/clients") || pathname.startsWith("/agents") },
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
  const initial = userName.trim().charAt(0).toUpperCase() || "?";

  return (
    <>
      {/* Телефон — строка сверху (знак, поиск, профиль); компьютер — узкая рельса со значками разделов */}
      <aside className="z-30 flex shrink-0 items-center gap-2 border-b border-border bg-surface/90 px-3 py-2.5 backdrop-blur md:sticky md:top-0 md:h-dvh md:w-[68px] md:flex-col md:gap-1 md:border-r md:border-b-0 md:bg-surface md:px-2.5 md:py-3 md:backdrop-blur-none">
        <CommandPalette pages={[...work, ...settings, ...help, { href: "/profile", label: t.nav.profile, icon: UserRound }]} />

        <Link href="/" title={t.app.name} className="flex min-w-0 shrink items-center gap-2.5 md:mb-3">
          <BrandMark size={36} />
          <span className="truncate font-display font-bold tracking-tight md:hidden">{t.app.name}</span>
        </Link>

        <button type="button" onClick={openSearch} aria-label={t.nav.search} className="order-last ml-auto grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-text md:hidden">
          <Search className="size-4" />
        </button>

        <nav aria-label={t.nav.groupWork} className="hidden flex-1 flex-col items-center gap-2 md:flex [&>div+div]:border-t [&>div+div]:border-border [&>div+div]:pt-2">
          <RailGroup items={work} tone="work" />
          {settings.length > 0 && <RailGroup items={settings} tone="settings" />}
          <RailGroup items={help} tone="help" />
        </nav>
        <span className="flex-1 md:hidden" />

        {/* Телефон: профиль (там же язык и выход) — аватаром в конце строки */}
        <Link href="/profile" title={t.nav.profile} className="order-last grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent md:hidden">
          {initial}
        </Link>

        {/* Компьютер: свернуть или показать панель, профиль с меню (язык, тема, плотность, выход) */}
        <div className="hidden flex-col items-center gap-1.5 md:flex">
          <button
            type="button"
            onClick={togglePanel}
            aria-label={panel ? t.shell.collapse : t.shell.expand}
            aria-pressed={panel}
            className="group/rail relative hidden size-10 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-text lg:grid"
          >
            {panel ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
            <RailTip>{panel ? t.shell.collapse : t.shell.expand}</RailTip>
          </button>
          <ProfileMenu userName={userName} initial={initial} active={pathname.startsWith("/profile")} />
        </div>
      </aside>
      {/* Телефон: нижняя панель — главные разделы и «Ещё» со всеми остальными (вне aside: у него размытие фона,
        которое сделало бы fixed относительным самому меню) */}
      <MobileTabs main={work.slice(0, 3)} more={[...work.slice(3), ...settings, ...help]} moreLabel={t.nav.more} />
    </>
  );
}

/** Подпись значка рельсы справа от него — при наведении и при переходе с клавиатуры. */
function RailTip({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute top-1/2 left-full z-50 ml-3 -translate-x-1 -translate-y-1/2 rounded-lg bg-text px-2.5 py-1 text-xs font-medium whitespace-nowrap text-bg opacity-0 shadow-lg transition group-hover/rail:translate-x-0 group-hover/rail:opacity-100 group-focus-visible/rail:translate-x-0 group-focus-visible/rail:opacity-100">
      {children}
    </span>
  );
}

/** Меню профиля в рельсе: имя, «Мой профиль», язык, тема, плотность таблиц, выход. Закрывается кликом мимо и Esc. */
function ProfileMenu({ userName, initial, active }: { userName: string; initial: string; active: boolean }) {
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
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t.shell.profileMenu}
        className={cx(
          "group/rail relative grid size-10 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent ring-2 ring-transparent transition hover:ring-accent/30",
          (open || active) && "ring-accent/40",
        )}
      >
        {initial}
        {!open && <RailTip>{userName}</RailTip>}
      </button>
      {open && (
        <div className="animate-pop-in absolute bottom-0 left-full z-50 ml-3 w-64 space-y-3 rounded-2xl border border-border bg-surface p-3 shadow-2xl shadow-black/15">
          <Link href="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition hover:bg-surface-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">{initial}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{userName}</span>
              <span className="block text-xs text-muted">{t.nav.profile}</span>
            </span>
          </Link>
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted">{t.nav.language}</span>
            <LocaleSwitch />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{t.nav.theme}</span>
            <ThemeSwitch />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">{t.shell.density}</span>
            <DensitySwitch />
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

/** Цвет значков группы меню: работа — сталь (акцент), настройки — фиолетовый, помощь — янтарный. */
const TONES = {
  work: "text-accent",
  settings: "text-violet-600 dark:text-violet-300",
  help: "text-amber-600 dark:text-amber-300",
} as const;
const ACTIVE_BG = {
  work: "bg-accent/12",
  settings: "bg-violet-500/12",
  help: "bg-amber-500/14",
} as const;

/** Группа значков рельсы: активный раздел — плашка цвета группы и полоска слева, подпись — при наведении. */
function RailGroup({ items, tone }: { items: NavItem[]; tone: keyof typeof TONES }) {
  return (
    <div className="flex flex-col items-center gap-1">
      {items.map(({ href, label, icon: Icon, active, badge }) => (
        <Link
          key={href}
          href={href}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cx(
            "group/rail relative grid size-10 place-items-center rounded-xl transition active:scale-95",
            active ? cx(ACTIVE_BG[tone], TONES[tone]) : "text-muted hover:bg-surface-2 hover:text-text",
          )}
        >
          {active && <span className="absolute top-2 bottom-2 -left-2.5 w-[3px] rounded-r-full bg-current" />}
          <Icon className="size-[18px]" />
          {badge ? <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 font-semibold text-white ring-2 ring-surface">{badge > 99 ? "99+" : badge}</span> : null}
          <RailTip>{label}</RailTip>
        </Link>
      ))}
    </div>
  );
}

type Density = "comfort" | "compact";
const DENSITY_EVENT = "genagent:density";

function readDensity(): Density {
  try {
    return localStorage.getItem("density") === "compact" ? "compact" : "comfort";
  } catch {
    return "comfort";
  }
}

function subscribeDensity(onChange: () => void) {
  window.addEventListener(DENSITY_EVENT, onChange);
  return () => window.removeEventListener(DENSITY_EVENT, onChange);
}

function setDensity(next: Density) {
  try {
    if (next === "compact") localStorage.setItem("density", "compact");
    else localStorage.removeItem("density");
  } catch {}
  document.documentElement.dataset.density = next;
  window.dispatchEvent(new Event(DENSITY_EVENT));
}

/** Плотность таблиц и списков: «просторно» или «компактно» — хранится в браузере, применяется атрибутом на <html>. */
export function DensitySwitch() {
  const { t } = useI18n();
  const density = useSyncExternalStore(subscribeDensity, readDensity, () => "comfort" as Density);
  const options: { value: Density; label: string; icon: typeof Rows3 }[] = [
    { value: "comfort", label: t.shell.densityComfort, icon: Rows3 },
    { value: "compact", label: t.shell.densityCompact, icon: Rows4 },
  ];
  return (
    <div className="inline-flex rounded-xl bg-surface-2 p-1" role="group" aria-label={t.shell.density}>
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={density === value}
          onClick={() => setDensity(value)}
          className={cx("grid size-6 place-items-center rounded-lg transition", density === value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

export function LocaleSwitch() {
  const { locale, t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div
      className={cx(
        "inline-flex rounded-xl bg-surface-2 p-1 text-xs font-semibold",
        pending && "opacity-60",
      )}
      role="group"
      aria-label={t.nav.language}
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => start(() => setLocale(l))}
          className={cx(
            "rounded-lg px-2.5 py-1 transition",
            l === locale
              ? "bg-surface text-text shadow-sm"
              : "text-muted hover:text-text",
          )}
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
  const theme = useSyncExternalStore(
    subscribeTheme,
    readTheme,
    () => "system" as Theme,
  );
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
    <div
      className="inline-flex rounded-xl bg-surface-2 p-1"
      role="group"
      aria-label={t.nav.theme}
    >
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => pick(value)}
          className={cx(
            "grid size-6 place-items-center rounded-lg transition",
            theme === value
              ? "bg-surface text-text shadow-sm"
              : "text-muted hover:text-text",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

/** Нижняя панель на телефоне: 3 главных раздела, поиск и «Ещё» (лист со всеми остальными разделами). */
function MobileTabs({
  main,
  more,
  moreLabel,
}: {
  main: NavItem[];
  more: NavItem[];
  moreLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const moreActive = more.some((m) => m.active);
  const tab =
    "flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium transition";
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] mx-3 grid grid-cols-3 gap-2 rounded-2xl border border-border bg-surface p-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {more.map(({ href, label, icon: Icon, active }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className={cx(
                  "flex flex-col items-center gap-1 rounded-xl p-2 text-center text-xs",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-surface-2",
                )}
              >
                <Icon className="size-5" />
                <span className="leading-tight">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {main.map(({ href, label, icon: Icon, active, badge }) => (
          <Link
            key={href}
            href={href}
            className={cx(tab, active ? "text-accent" : "text-muted")}
          >
            <span className="relative">
              <Icon className="size-5" />
              {badge ? (
                <span className="absolute -top-1.5 -right-2.5 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white">
                  {badge}
                </span>
              ) : null}
            </span>
            {label}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cx(tab, open || moreActive ? "text-accent" : "text-muted")}
        >
          <MoreHorizontal className="size-5" />
          {moreLabel}
        </button>
      </nav>
    </>
  );
}
