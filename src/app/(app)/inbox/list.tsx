"use client";

import type { ChannelType } from "@/db/schema";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AtSign, Camera, Globe, Send, Mail, Bot, MessageCircle, MessagesSquare, Phone, PhoneCall, Smartphone } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "@/components/ui";
import { contactLabel, waited } from "@/lib/contact";
import { ContactAvatar } from "@/components/contact-avatar";
import { RelTime } from "@/components/rel-time";
import { UserAvatar } from "@/components/user-avatar";
import { toast } from "@/components/toast";
import { assignToMe, bulkConversations } from "@/app/actions/team-inbox";
import { setConversationStatus } from "@/app/actions/inbox";
import { TagChip } from "./team-panel";

/** Событие: переключить поле ответа в режим заметки и поставить в него курсор (клавиша N). */
export const FOCUS_NOTE = "genagent:note";

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

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
  /** Карточка лида: горячий клиент — значок 🔥 */
  lead: "hot" | "warm" | "cold" | null;
  unread: number;
  typing: boolean;
  lastMessageText: string;
  lastMessageAt: Date;
  clientName: string;
  clientColor: string;
  agentName: string;
  /** Ответственный сотрудник (фото — v) */
  assignee: { id: string; name: string; v: number } | null;
  tags: string[];
};

export const CHANNEL_ICONS = { telegram: Send, widget: Globe, instagram: Camera, threads: AtSign, email: Mail, api: Bot, whatsapp: MessageCircle, viber: Phone, voice: PhoneCall, messenger: MessagesSquare, sms: Smartphone } as const;

export { contactLabel, waited, ContactAvatar };

export function ConversationList({ items, selectedId }: { items: ListItem[]; selectedId?: string }) {
  const { t } = useI18n();
  const x = t.inbox.team;
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, start] = useTransition();
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulk = (action: "close" | "mine" | "read") =>
    start(async () => {
      await bulkConversations([...picked], action).catch(() => toast(t.shell.saveFailed, "error"));
      setPicked(new Set());
    });

  // Клавиши как в почте: J/K — следующий/предыдущий, X — выбрать, A — взять себе, E — закрыть, R — ответ, N — заметка
  useEffect(() => {
    // После G — переход в раздел (общие клавиши), здесь не реагируем
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.code === "KeyG") {
        gAt = Date.now();
        return;
      }
      if (Date.now() - gAt < 1200) return;
      const i = items.findIndex((c) => c.id === selectedId);
      const go = (j: number) => {
        const c = items[Math.max(0, Math.min(items.length - 1, j))];
        if (c) router.replace(c.href);
      };
      if (e.code === "KeyJ") go(i < 0 ? 0 : i + 1);
      else if (e.code === "KeyK") go(i < 0 ? 0 : i - 1);
      else if (e.code === "KeyX" && selectedId) toggle(selectedId);
      else if (e.code === "KeyA" && selectedId) void assignToMe(selectedId).then(() => toast(x.takeMine));
      else if (e.code === "KeyE" && selectedId) void setConversationStatus(selectedId, "closed").then(() => go(i + 1));
      else if (e.code === "KeyR") (document.querySelector("textarea[data-reply]") as HTMLTextAreaElement | null)?.focus();
      else if (e.code === "KeyN") window.dispatchEvent(new Event(FOCUS_NOTE));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selectedId, router, x.takeMine]);
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString();
  const group = (at: Date) => (at.toDateString() === today ? t.inbox.groupToday : at.toDateString() === yesterday ? t.inbox.groupYesterday : t.inbox.groupEarlier);

  return (
    <div className="flex h-full flex-col">
      {picked.size > 0 && (
        <div className="animate-pop-in flex flex-wrap items-center gap-1.5 border-b border-border bg-accent-soft/60 px-3 py-2 text-xs">
          <span className="mr-auto font-semibold">{x.selected.replace("{n}", String(picked.size))}</span>
          {(
            [
              ["close", x.bulkClose],
              ["mine", x.bulkMine],
              ["read", x.bulkRead],
            ] as const
          ).map(([a, label]) => (
            <button key={a} type="button" disabled={busy} onClick={() => bulk(a)} className="rounded-lg bg-surface px-2 py-1 font-medium shadow-sm ring-1 ring-border transition hover:ring-accent/50">
              {label}
            </button>
          ))}
          <button type="button" onClick={() => setPicked(new Set())} aria-label={x.bulkClear} title={x.bulkClear} className="rounded-lg px-1.5 py-1 text-muted hover:text-text">
            ×
          </button>
        </div>
      )}
    <ul className="min-h-0 flex-1 overflow-y-auto">
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
              <span className="group/av relative shrink-0">
                <ContactAvatar id={c.id} label={label} anonymous={!c.contactName && !c.contactHandle} />
                {/* Выбор нескольких: флажок поверх аватара — при наведении или когда уже что-то выбрано */}
                <span
                  role="checkbox"
                  aria-checked={picked.has(c.id)}
                  aria-label={x.select}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggle(c.id);
                  }}
                  className={cx(
                    "absolute inset-0 grid place-items-center rounded-full border-2 transition",
                    picked.has(c.id) ? "border-accent bg-accent text-accent-text" : "border-transparent bg-surface/80 text-transparent opacity-0 group-hover/av:border-border group-hover/av:opacity-100",
                    picked.size > 0 && !picked.has(c.id) && "border-border opacity-100",
                  )}
                >
                  ✓
                </span>
                <span className="absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full border-2 border-surface bg-surface-2 text-muted">
                  <ChannelIcon className="size-2.5" />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: c.clientColor }} title={`${c.clientName} · ${c.agentName}`} />
                  <span className={cx("truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>{label}</span>
                  {c.mode === "human" && c.status !== "closed" && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[11px] leading-4 text-amber-600 dark:text-amber-400">{t.inbox.humanMode}</span>
                  )}
                  {c.lead === "hot" && c.status !== "closed" && (
                    <span className="shrink-0 text-[11px]" title={t.inbox.leadTemp.hot}>
                      🔥
                    </span>
                  )}
                  {c.upset && waiting && (
                    <span className="shrink-0 text-[11px]" title={t.home.upset}>
                      🔴
                    </span>
                  )}
                  <span className={cx("ml-auto shrink-0 text-[11px] tabular-nums", waiting ? "font-semibold text-danger" : "text-muted")}>
                    {waiting ? `${t.inbox.waits} ${waited(at, t)}` : <RelTime at={at} />}
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
                {(c.tags.length > 0 || c.assignee) && (
                  <span className="mt-1 flex items-center gap-1 overflow-hidden">
                    {c.tags.slice(0, 3).map((g) => (
                      <TagChip key={g} tag={g} small />
                    ))}
                    {c.assignee && (
                      <span className="ml-auto shrink-0" title={`${x.assignee}: ${c.assignee.name}`}>
                        <UserAvatar id={c.assignee.id} name={c.assignee.name} v={c.assignee.v} size={18} />
                      </span>
                    )}
                  </span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
    <p className="hidden border-t border-border px-3 py-1.5 text-[11px] leading-snug text-muted xl:block">{x.keysHint}</p>
    </div>
  );
}
