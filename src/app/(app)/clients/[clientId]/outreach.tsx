"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Mail, Pause, Pencil, Play, Send, Sheet, Sparkles, Trash2, Upload, Users, X } from "lucide-react";
import {
  approveAllOutreach,
  deleteContactList,
  deleteOutreach,
  generateOutreachAction,
  getOutreachMessages,
  importSheetList,
  saveOutreach,
  saveOutreachMessage,
  setOutreachMessageStatus,
  setOutreachSending,
} from "@/app/actions/outreach";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea, cx } from "@/components/ui";
import { ask } from "@/components/confirm-dialog";

export type ListRow = { id: string; name: string; count: number; withEmail: number; groups: { name: string; n: number }[]; unsubscribed: number };
export type OutreachRow = {
  id: string;
  name: string;
  listId: string;
  mode: "email" | "chats";
  channelId: string | null;
  brief: string;
  groupBriefs: Record<string, string>;
  research: boolean;
  status: "draft" | "generating" | "review" | "sending" | "done";
  error: string | null;
  counts: Record<string, number>;
};
export type EmailChannel = { id: string; name: string };
type Msg = Awaited<ReturnType<typeof getOutreachMessages>>[number];

export function OutreachManager({ clientId, lists, items, emailChannels, webSearch }: { clientId: string; lists: ListRow[]; items: OutreachRow[]; emailChannels: EmailChannel[]; webSearch: boolean }) {
  const { t } = useI18n();
  const o = t.outreach;
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const busy = items.some((x) => x.status === "generating" || x.status === "sending");
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [busy, router]);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">{o.subtitle}</p>
      <Lists clientId={clientId} lists={lists} />
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Mail className="size-4 text-accent" />
            {o.campaigns}
          </h2>
          {!creating && lists.length > 0 && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Sparkles className="size-4" />
              {o.new}
            </Button>
          )}
        </div>
        {lists.length === 0 && <p className="text-sm text-muted">{o.needList}</p>}
        {creating && <OutreachEditor clientId={clientId} lists={lists} emailChannels={emailChannels} webSearch={webSearch} onDone={() => setCreating(false)} />}
        {items.map((x) => (
          <OutreachCard key={x.id} clientId={clientId} row={x} lists={lists} emailChannels={emailChannels} webSearch={webSearch} />
        ))}
      </section>
    </div>
  );
}

function Lists({ clientId, lists }: { clientId: string; lists: ListRow[] }) {
  const { t } = useI18n();
  const o = t.outreach;
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [sheet, setSheet] = useState({ url: "", tab: "" });
  const [mode, setMode] = useState<"file" | "sheet" | null>(null);
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const upload = () =>
    start(async () => {
      const f = file.current?.files?.[0];
      if (!f) return setMsg({ error: true, text: o.errors.no_file });
      const body = new FormData();
      body.set("clientId", clientId);
      body.set("name", name);
      body.set("file", f);
      const res = await fetch("/api/contacts/upload", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string; count?: number };
      if (!res.ok || json.error) return setMsg({ error: true, text: (o.errors as Record<string, string>)[json.error ?? ""] ?? o.errors.parse_failed });
      setMsg({ text: o.imported.replace("{n}", String(json.count)) });
      setMode(null);
      setName("");
      router.refresh();
    });
  const fromSheet = () =>
    start(async () => {
      const r = await importSheetList(clientId, { name, url: sheet.url, sheet: sheet.tab });
      if (r.error) setMsg({ error: true, text: (o.errors as Record<string, string>)[r.error] ?? r.error });
      else {
        setMsg({ text: o.imported.replace("{n}", String(r.count)) });
        setMode(null);
        setName("");
      }
    });
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Users className="size-4 text-accent" />
          {o.lists}
        </h2>
        {mode === null && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setMode("file")}>
              <Upload className="size-4" />
              {o.uploadFile}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setMode("sheet")}>
              <Sheet className="size-4" />
              {o.fromSheet}
            </Button>
          </div>
        )}
      </div>
      {mode && (
        <Card className="space-y-3 p-4">
          <p className="text-xs text-muted">{o.columnsHint}</p>
          <Field label={o.listName}>
            <Input value={name} maxLength={100} placeholder={o.listNamePlaceholder} onChange={(e) => setName(e.target.value)} />
          </Field>
          {mode === "file" ? (
            <input ref={file} type="file" accept=".csv,.tsv,.txt,.xlsx" className="block w-full text-sm" />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Input className="min-w-72 flex-1 font-mono text-[13px]" value={sheet.url} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={(e) => setSheet({ ...sheet, url: e.target.value })} />
              <Input className="w-40" value={sheet.tab} placeholder={o.sheetTab} onChange={(e) => setSheet({ ...sheet, tab: e.target.value })} />
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={mode === "file" ? upload : fromSheet}>
              {pending ? <Spinner /> : <Upload className="size-4" />}
              {o.import}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              {o.cancel}
            </Button>
          </div>
        </Card>
      )}
      {msg && <p className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</p>}
      {lists.length === 0 && !mode ? (
        <EmptyState icon={<Users />} text={o.emptyLists} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {lists.map((l) => (
            <Card key={l.id} className="flex items-start gap-3 p-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{l.name}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {o.listStats.replace("{n}", String(l.count)).replace("{e}", String(l.withEmail))}
                  {l.unsubscribed > 0 && ` · ${o.unsubscribedN.replace("{n}", String(l.unsubscribed))}`}
                </div>
                {l.groups.length > 0 && <div className="mt-1 text-xs text-muted">{l.groups.map((g) => `${g.name}: ${g.n}`).join(" · ")}</div>}
              </div>
              <DeleteButton confirmText={o.confirmDeleteList} onDelete={() => deleteContactList(l.id)} />
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function DeleteButton({ confirmText, onDelete }: { confirmText: string; onDelete: () => Promise<unknown> }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={async () =>
        await ask(confirmText) &&
        start(async () => {
          await onDelete();
        })
      }
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

type Draft = Pick<OutreachRow, "name" | "listId" | "mode" | "channelId" | "brief" | "groupBriefs" | "research">;

function OutreachEditor({ clientId, id, initial, lists, emailChannels, webSearch, onDone }: { clientId: string; id?: string; initial?: Draft; lists: ListRow[]; emailChannels: EmailChannel[]; webSearch: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const o = t.outreach;
  const [d, setD] = useState<Draft>(initial ?? { name: "", listId: lists[0]?.id ?? "", mode: "email", channelId: emailChannels[0]?.id ?? null, brief: "", groupBriefs: {}, research: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const list = lists.find((l) => l.id === d.listId);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap gap-3">
        <Field label={o.name}>
          <Input className="w-64" value={d.name} maxLength={100} placeholder={o.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={o.list}>
          <Select className="w-56" value={d.listId} onChange={(e) => set("listId", e.target.value)}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.count})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={o.mode}>
          <Select className="w-64" value={d.mode} onChange={(e) => set("mode", e.target.value as Draft["mode"])}>
            <option value="email">{o.modes.email}</option>
            <option value="chats">{o.modes.chats}</option>
          </Select>
        </Field>
        {d.mode === "email" && (
          <Field label={o.from}>
            {emailChannels.length ? (
              <Select className="w-56" value={d.channelId ?? ""} onChange={(e) => set("channelId", e.target.value || null)}>
                {emailChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="max-w-64 text-xs text-danger">{o.noEmailChannel}</p>
            )}
          </Field>
        )}
      </div>
      <p className="text-xs text-muted">{d.mode === "email" ? o.modeHints.email : o.modeHints.chats}</p>
      <Field label={o.brief} hint={o.briefHint}>
        <Textarea rows={3} value={d.brief} maxLength={3000} placeholder={o.briefPlaceholder} onChange={(e) => set("brief", e.target.value)} />
      </Field>
      {list && list.groups.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">{o.groupBriefs}</div>
          <p className="text-xs text-muted">{o.groupBriefsHint}</p>
          {list.groups.map((g) => (
            <div key={g.name} className="flex flex-wrap items-start gap-2">
              <span className="w-40 pt-2 text-sm">
                {g.name} <span className="text-muted">· {g.n}</span>
              </span>
              <Textarea rows={2} className="min-w-64 flex-1" value={d.groupBriefs[g.name] ?? ""} maxLength={2000} placeholder={o.groupBriefPlaceholder} onChange={(e) => set("groupBriefs", { ...d.groupBriefs, [g.name]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={d.research} onChange={(e) => set("research", e.target.checked)} />
        <span>
          {o.research}
          <span className="block text-xs text-muted">{webSearch ? o.researchHint : o.researchOff}</span>
        </span>
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.name.trim() || d.brief.trim().length < 5}
          onClick={() =>
            start(async () => {
              const r = await saveOutreach(clientId, id ?? null, d);
              if (r.error) setError((o.errors as Record<string, string>)[r.error] ?? r.error);
              else onDone();
            })
          }
        >
          {o.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {o.cancel}
        </Button>
      </div>
    </Card>
  );
}

function OutreachCard({ clientId, row, lists, emailChannels, webSearch }: { clientId: string; row: OutreachRow; lists: ListRow[]; emailChannels: EmailChannel[]; webSearch: boolean }) {
  const { t } = useI18n();
  const o = t.outreach;
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const list = lists.find((l) => l.id === row.listId);
  const c = row.counts;
  const load = () => start(async () => setMsgs(await getOutreachMessages(row.id)));
  const toggle = () => {
    if (!open) load();
    setOpen(!open);
  };
  if (editing) return <OutreachEditor clientId={clientId} id={row.id} initial={row} lists={lists} emailChannels={emailChannels} webSearch={webSearch} onDone={() => setEditing(false)} />;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.name}</span>
            <Badge tone={row.status === "sending" ? "accent" : row.status === "done" ? "success" : row.status === "generating" ? "warning" : "neutral"}>
              {row.status === "generating" && <Spinner />} {o.statuses[row.status]}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted">
            {list?.name ?? "—"} · {o.modes[row.mode]}
            {row.research && ` · ${o.withResearch}`}
          </p>
          <p className="mt-1 text-xs text-muted">
            {(["ready", "approved", "sent", "skipped", "failed"] as const)
              .filter((k) => c[k])
              .map((k) => `${o.msgStatuses[k]}: ${c[k]}`)
              .join(" · ") || o.noDrafts}
          </p>
          {row.error && <p className="mt-1 text-xs text-danger">{row.error}</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          {row.status !== "generating" && row.status !== "sending" && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={async () => await ask(c.sent ? o.confirmRegenerateSent : o.confirmGenerate) && start(() => generateOutreachAction(row.id))}>
              <Sparkles className="size-4" />
              {c.ready || c.approved ? o.regenerate : o.generate}
            </Button>
          )}
          {c.ready > 0 && row.status !== "generating" && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(() => approveAllOutreach(row.id))}>
              <Check className="size-4" />
              {o.approveAll}
            </Button>
          )}
          {row.status === "sending" ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => void (await setOutreachSending(row.id, false)))}>
              <Pause className="size-4" />
              {o.pause}
            </Button>
          ) : (
            c.approved > 0 && (
              <Button
                size="sm"
                disabled={pending}
                onClick={async () =>
                  await ask(o.confirmSend.replace("{n}", String(c.approved))) &&
                  start(async () => {
                    const r = await setOutreachSending(row.id, true);
                    if (r.error) setError((o.errors as Record<string, string>)[r.error] ?? r.error);
                  })
                }
              >
                <Play className="size-4" />
                {o.send}
              </Button>
            )
          )}
          <Button size="sm" variant="ghost" title={o.edit} onClick={() => setEditing(true)}>
            <Pencil className="size-4" />
          </Button>
          <DeleteButton confirmText={o.confirmDelete} onDelete={() => deleteOutreach(row.id)} />
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {(c.ready || c.approved || c.sent || c.failed || c.skipped) > 0 && (
        <button type="button" className="mt-3 flex items-center gap-1 text-xs font-medium text-accent hover:underline" onClick={toggle}>
          <ChevronDown className={cx("size-3.5 transition", open && "rotate-180")} />
          {o.review}
        </button>
      )}
      {open && (
        <div className="mt-3 space-y-2">
          {!msgs ? (
            <Spinner />
          ) : (
            msgs.map((m) => <MessageRow key={m.id} m={m} onChanged={load} />)
          )}
        </div>
      )}
    </Card>
  );
}

function MessageRow({ m, onChanged }: { m: Msg; onChanged: () => void }) {
  const { t } = useI18n();
  const o = t.outreach;
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState({ subject: m.subject, body: m.body });
  const [pending, start] = useTransition();
  const editable = m.status === "ready" || m.status === "approved" || m.status === "skipped";
  return (
    <div className={cx("rounded-lg border border-border p-3 text-sm", m.status === "skipped" && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{m.contact.name || m.contact.email || m.contact.telegram}</span>
        <span className="text-xs text-muted">
          {[m.contact.company, m.contact.email || m.contact.telegram, m.contact.grp].filter(Boolean).join(" · ")}
        </span>
        <Badge tone={m.status === "sent" ? "success" : m.status === "approved" ? "accent" : m.status === "failed" ? "warning" : "neutral"}>{o.msgStatuses[m.status]}</Badge>
        <div className="ml-auto flex gap-1">
          {editable && (
            <Button size="sm" variant="ghost" title={o.edit} onClick={() => setEdit(!edit)}>
              <Pencil className="size-4" />
            </Button>
          )}
          {m.status === "ready" && (
            <Button size="sm" variant="ghost" title={o.approve} disabled={pending} onClick={() => start(async () => { await setOutreachMessageStatus(m.id, "approved"); onChanged(); })}>
              <Check className="size-4" />
            </Button>
          )}
          {(m.status === "ready" || m.status === "approved") && (
            <Button size="sm" variant="ghost" title={o.skip} disabled={pending} onClick={() => start(async () => { await setOutreachMessageStatus(m.id, "skipped"); onChanged(); })}>
              <X className="size-4" />
            </Button>
          )}
          {m.status === "skipped" && (
            <Button size="sm" variant="ghost" title={o.restore} disabled={pending} onClick={() => start(async () => { await setOutreachMessageStatus(m.id, "ready"); onChanged(); })}>
              <Send className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {m.research && <p className="mt-1 text-xs text-muted">🔎 {m.research}</p>}
      {m.error && <p className="mt-1 text-xs text-danger">{(o.errors as Record<string, string>)[m.error] ?? m.error}</p>}
      {edit ? (
        <div className="mt-2 space-y-2">
          <Input value={v.subject} maxLength={200} onChange={(e) => setV({ ...v, subject: e.target.value })} />
          <Textarea rows={7} value={v.body} maxLength={6000} onChange={(e) => setV({ ...v, body: e.target.value })} />
          <Button size="sm" disabled={pending || !v.body.trim()} onClick={() => start(async () => { await saveOutreachMessage(m.id, v); setEdit(false); onChanged(); })}>
            {o.save}
          </Button>
        </div>
      ) : (
        m.body && (
          <div className="mt-2 whitespace-pre-wrap">
            {m.subject && <div className="font-medium">{m.subject}</div>}
            {m.body}
          </div>
        )
      )}
    </div>
  );
}
