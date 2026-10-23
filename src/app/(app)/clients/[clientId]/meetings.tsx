"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileAudio, Mic, RefreshCw, Send, Trash2, Upload } from "lucide-react";
import { deleteMeeting, reanalyzeMeeting, sendMeeting } from "@/app/actions/meetings";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import type { MeetingTask } from "@/db/schema";

type Kind = "protocol" | "interview" | "sales" | "custom";
export type MeetingRow = {
  id: string;
  title: string;
  kind: Kind;
  instructions: string;
  filename: string;
  transcript: string;
  summary: string;
  result: string;
  tasks: MeetingTask[];
  score: number | null;
  status: "processing" | "done" | "error";
  error: string | null;
  at: number;
};
const KINDS: Kind[] = ["protocol", "interview", "sales", "custom"];

export function MeetingsManager({ clientId, rows, openai }: { clientId: string; rows: MeetingRow[]; openai: boolean }) {
  const { t, locale } = useI18n();
  const m = t.meetings;
  const router = useRouter();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const processing = rows.some((r) => r.status === "processing");
  // Пока что-то обрабатывается — обновляем список раз в 5 секунд
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [processing, router]);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{m.subtitle}</p>
      <NewMeeting clientId={clientId} openai={openai} />
      {rows.length === 0 && <EmptyState icon={<Mic />} text={m.empty} />}
      {rows.map((r) => (
        <MeetingCard key={r.id} row={r} when={fmt.format(r.at)} />
      ))}
    </div>
  );
}

function NewMeeting({ clientId, openai }: { clientId: string; openai: boolean }) {
  const { t } = useI18n();
  const m = t.meetings;
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [v, setV] = useState({ kind: "protocol" as Kind, title: "", instructions: "", text: "", team: false, owners: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      setError(null);
      const body = new FormData();
      body.set("clientId", clientId);
      body.set("kind", v.kind);
      body.set("title", v.title);
      body.set("instructions", v.instructions);
      if (v.team) body.set("team", "1");
      if (v.owners) body.set("owners", "1");
      const f = file.current?.files?.[0];
      if (f) body.set("file", f);
      else body.set("text", v.text);
      const res = await fetch("/api/meetings/upload", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) return setError((m.errors as Record<string, string>)[json.error ?? ""] ?? m.errors.failed);
      setV({ ...v, title: "", text: "" });
      if (file.current) file.current.value = "";
      router.refresh();
    });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <Mic className="size-4 text-accent" />
        {m.newTitle}
      </div>
      <Field label={m.file} hint={openai ? m.fileHint : m.fileHintNoOpenai}>
        <input ref={file} type="file" accept=".mp3,.m4a,.wav,.webm,.mp4,.mpeg,.mpga,.ogg,.oga,.flac,.txt,.vtt,.srt,.md,.docx,.pdf" className="block w-full text-sm" />
      </Field>
      <Field label={m.orText}>
        <Textarea rows={3} value={v.text} maxLength={400_000} placeholder={m.textPlaceholder} onChange={(e) => setV({ ...v, text: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label={m.kind}>
          <Select className="w-56" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as Kind })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {m.kinds[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={m.title}>
          <Input className="w-72" value={v.title} maxLength={120} placeholder={m.titlePlaceholder} onChange={(e) => setV({ ...v, title: e.target.value })} />
        </Field>
      </div>
      {v.kind !== "protocol" && (
        <Field label={m.instructions[v.kind]}>
          <Textarea rows={3} value={v.instructions} maxLength={3000} placeholder={m.instructionsPlaceholder[v.kind]} onChange={(e) => setV({ ...v, instructions: e.target.value })} />
        </Field>
      )}
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.team} onChange={(e) => setV({ ...v, team: e.target.checked })} />
          {m.toTeam}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.owners} onChange={(e) => setV({ ...v, owners: e.target.checked })} />
          {m.toOwners}
        </label>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button disabled={pending} onClick={submit}>
        {pending ? <Spinner /> : <Upload className="size-4" />}
        {m.start}
      </Button>
    </Card>
  );
}

function MeetingCard({ row, when }: { row: MeetingRow; when: string }) {
  const { t } = useI18n();
  const m = t.meetings;
  const [open, setOpen] = useState<"result" | "transcript" | "redo" | null>(null);
  const [redo, setRedo] = useState({ kind: row.kind, instructions: row.instructions });
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
          <FileAudio className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.title || row.filename || m.untitled}</span>
            <Badge tone="neutral">{m.kinds[row.kind]}</Badge>
            {row.status === "processing" && (
              <Badge tone="warning">
                <Spinner /> {m.processing}
              </Badge>
            )}
            {row.status === "error" && <Badge tone="warning">{m.statusError}</Badge>}
            {row.score != null && <Badge tone="accent">{m.score.replace("{n}", String(row.score))}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted">
            {when}
            {row.filename && ` · ${row.filename}`}
          </p>
          {row.status === "error" && row.error && <p className="mt-1 text-sm text-danger">{(m.errors as Record<string, string>)[row.error] ?? row.error}</p>}
          {row.summary && <p className="mt-2 text-sm">{row.summary}</p>}
          {row.tasks.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm">
              {row.tasks.map((x, i) => (
                <li key={i}>
                  • {x.who && <b>{x.who}: </b>}
                  {x.what}
                  {x.due && <span className="text-muted"> — {m.due} {x.due}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-xs font-medium">
            {row.result && (
              <button type="button" className="text-accent hover:underline" onClick={() => setOpen(open === "result" ? null : "result")}>
                {m.showResult}
              </button>
            )}
            {row.transcript && (
              <button type="button" className="text-accent hover:underline" onClick={() => setOpen(open === "transcript" ? null : "transcript")}>
                {m.showTranscript}
              </button>
            )}
            {row.transcript && row.status !== "processing" && (
              <button type="button" className="text-accent hover:underline" onClick={() => setOpen(open === "redo" ? null : "redo")}>
                {m.redo}
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {row.status === "done" && (
            <Button
              variant="ghost"
              size="sm"
              title={m.send}
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await sendMeeting(row.id, { team: true, owners: false });
                  setMsg(r.error ? m.errors.failed : m.sent);
                })
              }
            >
              <Send className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={pending} title={m.delete} onClick={() => confirm(m.confirmDelete) && start(() => deleteMeeting(row.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {msg && <p className="mt-2 text-sm text-muted">{msg}</p>}
      {open === "result" && <div className="mt-3 whitespace-pre-wrap rounded-lg bg-surface-2/60 p-3 text-sm">{row.result}</div>}
      {open === "transcript" && <div className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2/60 p-3 text-xs">{row.transcript}</div>}
      {open === "redo" && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <Select className="w-56" value={redo.kind} onChange={(e) => setRedo({ ...redo, kind: e.target.value as Kind })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {m.kinds[k]}
              </option>
            ))}
          </Select>
          {redo.kind !== "protocol" && (
            <Textarea rows={3} value={redo.instructions} maxLength={3000} placeholder={m.instructionsPlaceholder[redo.kind]} onChange={(e) => setRedo({ ...redo, instructions: e.target.value })} />
          )}
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await reanalyzeMeeting(row.id, redo);
                setOpen(null);
              })
            }
          >
            <RefreshCw className="size-4" />
            {m.redoStart}
          </Button>
        </div>
      )}
    </Card>
  );
}
