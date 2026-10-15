"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FlaskConical, MessageCircleQuestion, Radio, SlidersHorizontal, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "@/components/ui";

/** Вкладки агента (в общей шапке): активная — по адресу страницы. Счётчики: каналы, открытые вопросы, новые правки. */
export function AgentTabs({ agentId, channels, gaps, proposals }: { agentId: string; channels: number; gaps: number; proposals: number }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const base = `/agents/${agentId}`;
  const tabs = [
    { href: base, label: t.channels.setupTab, icon: SlidersHorizontal, n: null, tone: "neutral" },
    { href: `${base}/channels`, label: t.channels.tab, icon: Radio, n: channels, tone: "neutral" },
    { href: `${base}/tests`, label: t.tests.tab, icon: FlaskConical, n: null, tone: "neutral" },
    { href: `${base}/gaps`, label: t.gaps.tab, icon: MessageCircleQuestion, n: gaps || null, tone: "warning" },
    { href: `${base}/review`, label: t.review.tab, icon: Sparkles, n: proposals || null, tone: "accent" },
  ] as const;
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
      {tabs.map(({ href, label, icon: Icon, n, tone }) => {
        const active = href === base ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cx(
              "flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition",
              active ? "border-accent text-accent" : "border-transparent text-muted hover:text-text",
            )}
          >
            <Icon className="size-4" />
            {label}
            {n !== null && (
              <span
                className={cx(
                  "min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-semibold",
                  tone === "warning" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted",
                )}
              >
                {n}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
