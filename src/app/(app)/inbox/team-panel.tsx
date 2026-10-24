"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { AlarmClock, Hash, UserRound, X } from "lucide-react";
import { assignConversation, setConversationTags, snoozeConversation } from "@/app/actions/team-inbox";
import { useI18n } from "@/lib/i18n/client";
import { UserAvatar } from "@/components/user-avatar";
import { toast } from "@/components/toast";
import { cx } from "@/components/ui";

export type TeamState = { assigneeId: string | null; tags: string[]; snoozedUntil: number | null; suggestions: string[] };

/** Цвет метки — по её тексту (одна и та же метка всегда одного цвета). */
export function tagColor(tag: string) {
  let h = 0;
  for (const ch of tag.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 45%)`;
}

export function TagChip({ tag, href, onRemove, small }: { tag: string; href?: string; onRemove?: () => void; small?: boolean }) {
  const c = tagColor(tag);
  const body = (
    <>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: c }} />
      <span className="truncate">{tag}</span>
    </>
  );
  const cls = cx("inline-flex max-w-full items-center gap-1 rounded-full border px-2 font-medium", small ? "py-0 text-[11px]" : "py-0.5 text-xs");
  const style = { borderColor: `color-mix(in srgb, ${c} 35%, transparent)`, background: `color-mix(in srgb, ${c} 10%, transparent)` };
  return (
    <span className={cls} style={style}>
      {href ? (
        <Link href={href} replace className="inline-flex min-w-0 items-center gap-1 hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="×" className="-mr-1 grid size-4 place-items-center rounded-full text-muted hover:text-text">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Ближайшее время: через n часов или в 9:00 через d дней (по часам браузера сотрудника). */
function at(hours: number, days?: number) {
  const d = new Date();
  if (days === undefined) return d.getTime() + hours * 3_600_000;
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/**
 * «Команда» в карточке разговора: ответственный (с фото), метки с подсказками, «отложить до…». Изменения видны сразу,
 * сохранение — в фоне.
 */
export function TeamPanel({ conversationId, meId, team, staff, tagLink }: { conversationId: string; meId: string; team: TeamState; staff: { id: string; name: string; v: number }[]; tagLink: string }) {
  const { t, locale } = useI18n();
  const x = t.inbox.team;
  const [, start] = useTransition();
  const [assignee, setAssignee] = useOptimistic(team.assigneeId);
  const [tags, setTags] = useOptimistic(team.tags);
  const [draft, setDraft] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const who = staff.find((u) => u.id === assignee);
  const fail = () => toast(t.shell.saveFailed, "error");

  const assign = (id: string | null) =>
    start(async () => {
      setAssignee(id);
      const r = await assignConversation(conversationId, id).catch(() => ({ error: "x" }));
      if (r.error) fail();
    });
  const saveTags = (next: string[]) =>
    start(async () => {
      setTags(next);
      await setConversationTags(conversationId, next).catch(fail);
    });
  const addTag = (v: string) => {
    const tag = v.replace(/\s+/g, " ").trim().slice(0, 24);
    setDraft("");
    if (tag && !tags.includes(tag) && tags.length < 8) saveTags([...tags, tag]);
  };
  const snooze = (until: number | null) => {
    setSnoozeOpen(false);
    start(async () => {
      const r = await snoozeConversation(conversationId, until).catch(() => ({ error: "x" }));
      if (r.error) fail();
    });
  };
  // Сколько дней до понедельника, 9:00 (если сегодня понедельник — через неделю)
  const toMonday = ((8 - new Date().getDay()) % 7) || 7;
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4 border-b border-border p-5 text-sm">
      <div className="text-xs font-semibold tracking-wider text-muted uppercase">{x.title}</div>

      {/* Ответственный */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{x.assignee}</span>
          {assignee !== meId && (
            <button type="button" onClick={() => assign(meId)} className="text-xs font-medium text-accent hover:underline">
              {x.takeMine}
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 rounded-xl border border-border bg-surface px-2 py-1.5 focus-within:border-accent">
          {who ? <UserAvatar id={who.id} name={who.name} v={who.v} size={22} /> : <UserRound className="size-[18px] text-muted" />}
          <select value={assignee ?? ""} onChange={(e) => assign(e.target.value || null)} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" aria-label={x.assignee}>
            <option value="">{x.nobody}</option>
            {staff.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Метки */}
      <div className="space-y-1.5">
        <span className="text-xs text-muted">{x.tags}</span>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((g) => (
              <TagChip key={g} tag={g} href={tagLink.replace("__TAG__", encodeURIComponent(g))} onRemove={() => saveTags(tags.filter((v) => v !== g))} />
            ))}
          </div>
        )}
        {tags.length < 8 && (
          <label className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-1 focus-within:border-accent">
            <Hash className="size-3.5 text-muted" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag(draft);
                }
              }}
              list={`tags-${conversationId}`}
              maxLength={24}
              placeholder={x.addTag}
              title={x.tagHint}
              className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] outline-none placeholder:text-muted/70"
            />
            <datalist id={`tags-${conversationId}`}>
              {team.suggestions.filter((g) => !tags.includes(g)).map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
        )}
      </div>

      {/* Отложить */}
      <div className="relative">
        {team.snoozedUntil ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-violet-500/10 px-3 py-2 text-[13px] text-violet-700 dark:text-violet-300">
            <span className="flex items-center gap-1.5">
              <AlarmClock className="size-4" />
              {x.snoozedUntil.replace("{t}", fmt.format(team.snoozedUntil))}
            </span>
            <button type="button" onClick={() => snooze(null)} className="text-xs font-medium hover:underline">
              {x.unsnooze}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setSnoozeOpen((v) => !v)} aria-expanded={snoozeOpen} className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-[13px] text-muted transition hover:border-accent/50 hover:text-text">
            <AlarmClock className="size-4" />
            {x.snooze}
          </button>
        )}
        {snoozeOpen && (
          <div className="animate-pop-in absolute inset-x-0 top-full z-20 mt-1 rounded-xl border border-border bg-surface p-1 shadow-xl">
            {[
              [x.snooze1h, at(1)],
              [x.snooze3h, at(3)],
              [x.snoozeTomorrow, at(0, 1)],
              [x.snoozeMonday, at(0, toMonday)],
            ].map(([label, when]) => (
              <button key={String(label)} type="button" onClick={() => snooze(Number(when))} className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2">
                {label}
                <span className="text-xs text-muted">{fmt.format(Number(when))}</span>
              </button>
            ))}
            <p className="px-2.5 pt-1 pb-1.5 text-[11px] leading-snug text-muted">{x.snoozeHint}</p>
          </div>
        )}
      </div>
    </div>
  );
}
