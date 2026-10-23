"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Copy, ExternalLink, Pencil, PenLine, Send, Sparkles, Trash2 } from "lucide-react";
import { deleteContentItem, generateContentAction, saveContentItem, scheduleContent, unscheduleContent } from "@/app/actions/content";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import { CONTENT_KINDS, CONTENT_PLATFORMS } from "@/lib/content/kinds";

type Kind = (typeof CONTENT_KINDS)[number];
type Platform = (typeof CONTENT_PLATFORMS)[number];
export type ContentRow = {
  id: string;
  batch: string;
  kind: Kind;
  platform: Platform;
  brief: string;
  title: string;
  text: string;
  status: "draft" | "scheduled" | "published" | "failed";
  channelId: string | null;
  target: string;
  publishAt: number | null;
  publishedAt: number | null;
  url: string;
  error: string | null;
  at: number;
};
export type ContentBot = { id: string; name: string };

export function ContentStudio({ clientId, rows, bots }: { clientId: string; rows: ContentRow[]; bots: ContentBot[] }) {
  const { t, locale } = useI18n();
  const c = t.content;
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const batches = [...new Set(rows.map((r) => r.batch))].map((b) => rows.filter((r) => r.batch === b));
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{c.subtitle}</p>
      <Generator clientId={clientId} />
      {rows.length === 0 && <EmptyState icon={<PenLine />} text={c.empty} />}
      {batches.map((items) => (
        <section key={items[0].batch} className="space-y-2">
          <div className="text-xs text-muted">
            {fmt.format(items[0].at)} · {c.kinds[items[0].kind]} · {c.platforms[items[0].platform]} · «{items[0].brief.slice(0, 140)}»
          </div>
          {items.map((r, i) => (
            <ItemCard key={r.id} clientId={clientId} row={r} bots={bots} label={items.length > 1 ? `${c.variant} ${String.fromCharCode(65 + i)}` : ""} fmt={fmt} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Generator({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  const c = t.content;
  const [v, setV] = useState({ kind: "post" as Kind, platform: "telegram" as Platform, brief: "", tone: "", length: "medium" as "short" | "medium" | "long", variants: 2, useKb: true });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV({ ...v, [k]: val });
  const submit = () =>
    start(async () => {
      setError(null);
      const r = await generateContentAction(clientId, v);
      if (r.error) setError((c.errors as Record<string, string>)[r.error] ?? c.errors.failed);
      else set("brief", "");
    });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <Sparkles className="size-4 text-accent" />
        {c.newTitle}
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={c.kind}>
          <Select className="w-48" value={v.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
            {CONTENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {c.kinds[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={c.platform}>
          <Select className="w-44" value={v.platform} onChange={(e) => set("platform", e.target.value as Platform)}>
            {CONTENT_PLATFORMS.map((k) => (
              <option key={k} value={k}>
                {c.platforms[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={c.length}>
          <Select className="w-40" value={v.length} disabled={v.kind === "ad"} onChange={(e) => set("length", e.target.value as typeof v.length)}>
            {(["short", "medium", "long"] as const).map((k) => (
              <option key={k} value={k}>
                {c.lengths[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={c.variants}>
          <Select className="w-24" value={v.variants} onChange={(e) => set("variants", Number(e.target.value))}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={c.brief} hint={c.briefHint}>
        <Textarea rows={3} value={v.brief} maxLength={3000} placeholder={c.briefPlaceholder[v.kind]} onChange={(e) => set("brief", e.target.value)} />
      </Field>
      <Field label={c.tone}>
        <Input value={v.tone} maxLength={200} placeholder={c.tonePlaceholder} onChange={(e) => set("tone", e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.useKb} onChange={(e) => set("useKb", e.target.checked)} />
        {c.useKb}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button disabled={pending || v.brief.trim().length < 3} onClick={submit}>
        {pending ? <Spinner /> : <Sparkles className="size-4" />}
        {pending ? c.generating : c.generate}
      </Button>
    </Card>
  );
}

/** Значение для <input type="datetime-local"> в часовом поясе браузера */
const localInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function ItemCard({ clientId, row, bots, label, fmt }: { clientId: string; row: ContentRow; bots: ContentBot[]; label: string; fmt: Intl.DateTimeFormat }) {
  const { t } = useI18n();
  const c = t.content;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; text: string; channelId: string | null; target: string }>({ title: row.title, text: row.text, channelId: row.channelId ?? bots[0]?.id ?? null, target: row.target });
  const [when, setWhen] = useState(() => localInput(Date.now() + 60 * 60_000));
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const canPublish = row.platform === "telegram" && bots.length > 0;
  const save = (then?: () => Promise<void>) =>
    start(async () => {
      const r = await saveContentItem(clientId, row.id, draft);
      if (r.error) return setMsg({ error: true, text: (c.errors as Record<string, string>)[r.error] ?? r.error });
      setEditing(false);
      await then?.();
    });
  const publish = (at: number | null) =>
    save(async () => {
      const r = await scheduleContent(clientId, row.id, at);
      if (r.error) setMsg({ error: true, text: (c.errors as Record<string, string>)[r.error] ?? r.error });
      else setMsg({ text: at == null ? c.published : c.scheduledOk });
    });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {label && <Badge tone="neutral">{label}</Badge>}
            {row.title && <span className="font-semibold">{row.title}</span>}
            {row.status !== "draft" && <Badge tone={row.status === "published" ? "success" : "warning"}>{c.statuses[row.status]}</Badge>}
            {row.status === "scheduled" && row.publishAt && <span className="text-xs text-muted">{fmt.format(row.publishAt)}</span>}
            {row.url && (
              <a href={row.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-accent hover:underline">
                <ExternalLink className="size-3.5" />
                {c.open}
              </a>
            )}
          </div>
          {row.status === "failed" && row.error && <p className="mt-1 text-xs text-danger">{(c.errors as Record<string, string>)[row.error] ?? row.error}</p>}
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            title={c.copy}
            onClick={() => {
              void navigator.clipboard.writeText(row.title && row.kind !== "post" ? `${row.title}\n\n${row.text}` : row.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy className="size-4" />
            {copied && <span className="text-xs">{c.copied}</span>}
          </Button>
          <Button variant="ghost" size="sm" title={c.edit} onClick={() => setEditing(!editing)}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} title={c.delete} onClick={() => confirm(c.confirmDelete) && start(() => deleteContentItem(row.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="mt-3 space-y-2">
          <Input value={draft.title} maxLength={300} placeholder={c.titlePlaceholder} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <Textarea rows={10} value={draft.text} maxLength={20_000} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <Button size="sm" disabled={pending || !draft.text.trim()} onClick={() => save()}>
            {c.save}
          </Button>
        </div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap text-sm">{row.text}</p>
      )}
      {row.platform === "telegram" && row.status !== "published" && (
        <div className="mt-4 space-y-2 border-t border-border pt-3">
          {!canPublish ? (
            <p className="text-xs text-muted">{c.noBots}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={c.bot}>
                  <Select className="w-52" value={draft.channelId ?? ""} onChange={(e) => setDraft({ ...draft, channelId: e.target.value || null })}>
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={c.target}>
                  <Input className="w-52 font-mono text-[13px]" value={draft.target} maxLength={200} placeholder="@my_channel" onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
                </Field>
              </div>
              <p className="text-xs text-muted">{c.targetHint}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={pending || !draft.target.trim()} onClick={() => confirm(c.confirmPublish) && publish(null)}>
                  {pending ? <Spinner /> : <Send className="size-4" />}
                  {c.publishNow}
                </Button>
                {row.status === "scheduled" ? (
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(() => unscheduleContent(row.id))}>
                    {c.unschedule}
                  </Button>
                ) : (
                  <>
                    <Input type="datetime-local" className="w-56" value={when} onChange={(e) => setWhen(e.target.value)} />
                    <Button size="sm" variant="secondary" disabled={pending || !draft.target.trim() || !when} onClick={() => publish(new Date(when).getTime())}>
                      <CalendarClock className="size-4" />
                      {c.schedule}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {msg && <p className={msg.error ? "mt-2 text-sm text-danger" : "mt-2 text-sm text-success"}>{msg.text}</p>}
    </Card>
  );
}
