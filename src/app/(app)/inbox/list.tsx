"use client";

import type { ChannelType } from "@/db/schema";
import Link from "next/link";
import { AtSign, Camera, Globe, Send, UserRound, Mail, Bot } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "@/components/ui";

export type ListItem = {
  id: string;
  href: string;
  contactName: string;
  contactHandle: string;
  channelType: ChannelType;
  mode: "ai" | "human";
  status: "open" | "closed";
  needsAttention: boolean;
  unread: number;
  typing: boolean;
  lastMessageText: string;
  lastMessageAt: Date;
  clientName: string;
  clientColor: string;
  agentName: string;
};

export const CHANNEL_ICONS = { telegram: Send, widget: Globe, instagram: Camera, threads: AtSign, email: Mail, api: Bot } as const;

export function contactLabel(
  c: { contactName: string; contactHandle: string; channelType: string; id: string },
  labels: { visitor: string; instagramUser: string },
) {
  const fallback = c.channelType === "instagram" ? labels.instagramUser : labels.visitor;
  return c.contactName || c.contactHandle || `${fallback} #${c.id.slice(0, 4).toUpperCase()}`;
}

export function ConversationList({ items, selectedId }: { items: ListItem[]; selectedId?: string }) {
  const { t, locale } = useI18n();
  const today = new Date().toDateString();
  const time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { timeStyle: "short" });
  const date = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "short" });

  return (
    <ul className="h-full divide-y divide-border overflow-y-auto">
      {items.map((c) => {
        const at = new Date(c.lastMessageAt);
        const ChannelIcon = CHANNEL_ICONS[c.channelType];
        return (
          <li key={c.id}>
            <Link
              href={c.href}
              replace
              className={cx(
                "flex gap-3 px-4 py-3 transition",
                c.id === selectedId ? "bg-accent-soft/70" : "hover:bg-surface-2",
              )}
            >
              <span className="relative shrink-0">
                <span
                  className="grid size-10 place-items-center rounded-full text-sm font-semibold text-white"
                  style={{ background: c.clientColor }}
                >
                  {c.contactName ? c.contactName.charAt(0).toUpperCase() : <UserRound className="size-5" />}
                </span>
                <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border-2 border-surface bg-surface-2 text-muted">
                  <ChannelIcon className="size-2.5" />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cx("truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>
                    {contactLabel(c, t.inbox)}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {at.toDateString() === today ? time.format(at) : date.format(at)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={cx("truncate text-xs", c.unread > 0 ? "text-text" : "text-muted")}>
                    {c.typing ? <i className="text-accent">{t.inbox.typing}</i> : c.lastMessageText}
                  </span>
                  {c.unread > 0 && (
                    <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-text">
                      {c.unread}
                    </span>
                  )}
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                  {c.needsAttention && c.status !== "closed" && <span className="size-2 rounded-full bg-danger" />}
                  <span className="truncate">
                    {c.clientName} · {c.agentName}
                  </span>
                  {c.mode === "human" && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1 text-amber-600 dark:text-amber-400">
                      {t.inbox.humanMode}
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
