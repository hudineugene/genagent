import Link from "next/link";
import { FlaskConical, MessageCircleQuestion, Radio, SlidersHorizontal } from "lucide-react";
import type { Dict } from "@/lib/i18n";
import { cx } from "@/components/ui";

export function AgentTabs({
  agentId,
  active,
  channels,
  gaps = null,
  t,
}: {
  agentId: string;
  active: "setup" | "channels" | "tests" | "gaps";
  channels: number;
  /** Открытых вопросов без ответа (null — не показывать счётчик) */
  gaps?: number | null;
  t: Dict;
}) {
  const tabs = [
    { key: "setup", href: `/agents/${agentId}`, label: t.channels.setupTab, icon: SlidersHorizontal, n: null },
    { key: "channels", href: `/agents/${agentId}/channels`, label: t.channels.tab, icon: Radio, n: channels },
    { key: "tests", href: `/agents/${agentId}/tests`, label: t.tests.tab, icon: FlaskConical, n: null },
    { key: "gaps", href: `/agents/${agentId}/gaps`, label: t.gaps.tab, icon: MessageCircleQuestion, n: gaps || null },
  ] as const;
  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]">
      {tabs.map(({ key, href, label, icon: Icon, n }) => (
        <Link
          key={key}
          href={href}
          className={cx(
            "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
            active === key ? "border-accent text-accent" : "border-transparent text-muted hover:text-text",
          )}
        >
          <Icon className="size-4" />
          {label}
          {n !== null && <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">{n}</span>}
        </Link>
      ))}
    </div>
  );
}
