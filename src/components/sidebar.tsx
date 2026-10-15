"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { BarChart3, Building2, LogOut, MessagesSquare, Plug, Sparkles, UserRound, Users } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n";
import { logout, setLocale } from "@/app/actions/auth";
import { cx } from "./ui";

export function Sidebar({ userName, isAdmin, inboxBadge }: { userName: string; isAdmin: boolean; inboxBadge: number }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const items = [
    {
      href: "/",
      label: t.nav.clients,
      icon: Building2,
      active: pathname === "/" || pathname.startsWith("/clients") || pathname.startsWith("/agents"),
    },
    {
      href: "/inbox",
      label: t.nav.inbox,
      icon: MessagesSquare,
      active: pathname.startsWith("/inbox"),
      badge: inboxBadge,
    },
    { href: "/analytics", label: t.nav.analytics, icon: BarChart3, active: pathname.startsWith("/analytics") },
    ...(isAdmin
      ? [
          { href: "/team", label: t.nav.team, icon: Users, active: pathname.startsWith("/team") },
          { href: "/integrations", label: t.nav.integrations, icon: Plug, active: pathname.startsWith("/integrations") },
        ]
      : []),
    { href: "/profile", label: t.nav.profile, icon: UserRound, active: pathname.startsWith("/profile") },
  ];

  return (
    <aside className="flex shrink-0 items-center justify-between gap-2 overflow-x-auto [scrollbar-width:none] border-b border-border bg-surface px-4 py-3 md:sticky md:top-0 md:h-dvh md:w-60 md:flex-col md:items-stretch md:justify-start md:gap-4 md:overflow-visible md:border-r md:border-b-0 md:px-4 md:py-6">
      <Link href="/" className="flex shrink-0 items-center gap-2.5 md:mb-4 md:px-2">
        <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-text">
          <Sparkles className="size-5" />
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block font-semibold">{t.app.name}</span>
          <span className="hidden text-xs text-muted md:block">{t.app.tagline}</span>
        </span>
      </Link>

      <nav className="flex shrink-0 gap-0.5 md:flex-1 md:flex-col md:gap-1">
        {items.map(({ href, label, icon: Icon, active, ...rest }) => (
          <Link
            key={href}
            href={href}
            title={label}
            className={cx(
              "flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium transition md:px-3",
              active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <span className="relative">
              <Icon className="size-4" />
              {"badge" in rest && rest.badge ? (
                <span className="absolute -top-1.5 -right-2 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white md:hidden">
                  {rest.badge}
                </span>
              ) : null}
            </span>
            <span className="hidden md:inline">{label}</span>
            {"badge" in rest && rest.badge ? (
              <span className="ml-auto hidden rounded-full bg-danger px-1.5 text-xs font-semibold text-white md:inline">
                {rest.badge}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-1 md:flex-col md:items-stretch md:gap-3">
        <LocaleSwitch />
        <div className="hidden truncate px-2 text-xs text-muted md:block">{userName}</div>
        <form action={logout}>
          <button
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted transition hover:bg-surface-2 hover:text-text"
            title={t.nav.logout}
          >
            <LogOut className="size-4" />
            <span className="hidden md:inline">{t.nav.logout}</span>
          </button>
        </form>
      </div>
    </aside>
  );
}

export function LocaleSwitch() {
  const { locale, t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div
      className={cx("inline-flex rounded-xl bg-surface-2 p-1 text-xs font-semibold", pending && "opacity-60")}
      role="group"
      aria-label={t.nav.language}
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => start(() => setLocale(l))}
          className={cx(
            "flex-1 rounded-lg px-3 py-1.5 transition",
            l === locale ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
