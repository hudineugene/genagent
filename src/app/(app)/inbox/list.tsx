"use client";

import type { ChannelType } from "@/db/schema";
import Link from "next/link";
import { AtSign, Camera, Globe, Send, Mail, Bot, MessageCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "@/components/ui";
import { contactLabel, waited } from "@/lib/contact";
import { ContactAvatar } from "@/components/contact-avatar";

export type ListItem = {
  id: string;
  href: string;
  contactName: string;
  contactHandle: string;
  channelType: ChannelType;
  mode: "ai" | "human";
  status: "open" | "closed";
  needsAttention: boolean;
  upset: boolean;
  unread: number;
  typing: boolean;
  lastMessageText: string;
  lastMessageAt: Date;
  clientName: string;
  clientColor: string;
  agentName: string;
};

export const CHANNEL_ICONS = { telegram: Send, widget: Globe, instagram: Camera, threads: AtSign, email: Mail, api: Bot, whatsapp: MessageCircle } as const;

export { contactLabel, waited, ContactAvatar };

export function ConversationList({ items, selectedId }: { items: ListItem[]; selectedId?: string }) {
  const { t, locale } = useI18n();
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString();
  const time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { timeStyle: "short" });
  const date = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "short" });
  const group = (at: Date) => (at.toDateString() === today ? t.inbox.groupToday : at.toDateString() === yesterday ? t.inbox.groupYesterday : t.inbox.groupEarlier);

  return (
    <ul className="h-full overflow-y-auto">
      {items.map((c, i) => {
        const at = new Date(c.lastMessageAt);
        const g = group(at);
        const showGroup = i === 0 || group(new Date(items[i - 1].lastMessageAt)) !== g;
        const ChannelIcon = CHANNEL_ICONS[c.channelType];
        const label = contactLabel(c, t.inbox);
        const waiting = c.needsAttention && c.status !== "closed";
        const selected = c.id === selectedId;
        return (
          <li key={c.id}>
            {showGroup && (
              <div className="sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase backdrop-blur">
                {g}
              </div>
            )}
            <Link
              href={c.href}
              replace
              className={cx(
                "relative flex items-center gap-3 border-b border-border/60 px-4 py-3 transition",
                selected ? "bg-accent-soft/70" : "hover:bg-surface-2/70",
              )}
            >
              {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
              <span className="relative shrink-0">
                <ContactAvatar id={c.id} label={label} anonymous={!c.contactName && !c.contactHandle} />
                <span className="absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full border-2 border-surface bg-surface-2 text-muted">
                  <ChannelIcon className="size-2.5" />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: c.clientColor }} title={`${c.clientName} · ${c.agentName}`} />
                  <span className={cx("truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>{label}</span>
                  {c.mode === "human" && c.status !== "closed" && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] leading-4 text-amber-600 dark:text-amber-400">{t.inbox.humanMode}</span>
                  )}
                  {c.upset && waiting && (
                    <span className="shrink-0 text-[11px]" title={t.home.upset}>
                      🔴
                    </span>
                  )}
                  <span className={cx("ml-auto shrink-0 text-[11px] tabular-nums", waiting ? "font-semibold text-danger" : "text-muted")}>
                    {waiting ? `${t.inbox.waits} ${waited(at, t)}` : at.toDateString() === today ? time.format(at) : date.format(at)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={cx("truncate text-[13px]", c.unread > 0 ? "text-text" : "text-muted")}>
                    {c.typing ? <i className="text-accent">{t.inbox.typing}</i> : c.lastMessageText}
                  </span>
                  {c.unread > 0 && (
                    <span className="ml-auto min-w-5 shrink-0 rounded-full bg-accent px-1.5 text-center text-[11px] leading-5 font-semibold text-accent-text">
                      {c.unread}
                    </span>
                  )}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
