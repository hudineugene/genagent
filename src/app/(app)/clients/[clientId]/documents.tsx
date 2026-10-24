"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Download, ExternalLink, FileInput, FileText, Folder, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { deleteArchivedDoc, deleteDocType, saveDocType } from "@/app/actions/documents";
import { deleteDocTemplate, saveDocTemplate } from "@/app/actions/doc-templates";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, Textarea, buttonClass } from "@/components/ui";
import type { DocField } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

export type DocTypeRow = {
  id: string;
  name: string;
  purpose: string;
  fields: DocField[];
  notify: boolean;
  enabled: boolean;
  folder: string;
  nameTemplate: string;
  total: number;
  recent: { at: number; contact: string; filename: string; fields: Record<string, string>; summary: string }[];
};
export type DocTemplateRow = {
  id: string;
  name: string;
  purpose: string;
  body: string;
  fields: DocField[];
  enabled: boolean;
  counter: number;
  usedBy: string[];
  recent: { id: string; at: number; title: string; contact: string }[];
};
type TypeDraft = Pick<DocTypeRow, "name" | "purpose" | "fields" | "notify" | "enabled" | "folder" | "nameTemplate">;
export type ArchivedDoc = { id: string; title: string; folder: string; summary: string; at: number; file: boolean; size: number; contact: string };
type TemplateDraft = Pick<DocTemplateRow, "name" | "purpose" | "body" | "fields" | "enabled">;

const newField = (n: number): DocField => ({ key: `field${n}`, label: "" });
const BUILTIN = new Set(["date", "number", "client"]);
/** Поля шаблона — из {{key}} в тексте (кроме встроенных); подписи сохраняем, что уже ввели. */
const templateKeys = (body: string) => [...new Set([...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].filter((k) => !BUILTIN.has(k));

export function DocumentsManager({ clientId, types, templates, archive = [] }: { clientId: string; types: DocTypeRow[]; templates: DocTemplateRow[]; archive?: ArchivedDoc[] }) {
  const { t, locale } = useI18n();
  const d = t.documents;
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-8">
      <ArchiveSection clientId={clientId} docs={archive} />
      <section className="space-y-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <FileInput className="size-4 text-accent" />
            {d.inTitle}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">{d.inSubtitle}</p>
        </div>
        {editing !== "type" && (
          <Button onClick={() => setEditing("type")}>
            <Plus className="size-4" />
            {d.newType}
          </Button>
        )}
        {editing === "type" && <TypeEditor clientId={clientId} initial={{ name: "", purpose: "", fields: [newField(1)], notify: true, enabled: true, folder: "", nameTemplate: "" }} onDone={() => setEditing(null)} />}
        {types.length === 0 && editing !== "type" && <EmptyState icon={<FileInput />} text={d.typesEmpty} />}
        {types.map((r) =>
          editing === r.id ? (
            <TypeEditor key={r.id} clientId={clientId} id={r.id} initial={r} onDone={() => setEditing(null)} />
          ) : (
            <Card key={r.id} className="p-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.name}</span>
                    {!r.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
                  </div>
                  {r.purpose && <p className="mt-1 text-sm text-muted">{r.purpose}</p>}
                  <p className="mt-1 text-xs text-muted">{r.fields.map((x) => x.label).join(" · ")}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted">
                    <Folder className="size-3.5" />
                    {r.folder || r.name}
                    {r.nameTemplate && <span className="font-mono"> · {r.nameTemplate}</span>}
                  </p>
                  <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    {d.received.replace("{n}", String(r.total))}
                  </button>
                </div>
                <div className="flex gap-1">
                  {r.total > 0 && (
                    <a href={`/api/documents/${clientId}/csv?type=${r.id}`} className={buttonClass("secondary", "sm")}>
                      <Download className="size-4" />
                      {d.download}
                    </a>
                  )}
                  <Button variant="ghost" size="sm" title={d.edit} onClick={() => setEditing(r.id)}>
                    <Pencil className="size-4" />
                  </Button>
                  <DeleteButton confirmText={d.confirmDeleteType} onDelete={() => deleteDocType(r.id)} />
                </div>
              </div>
              {open === r.id && (
                <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                  {r.recent.length === 0 && <p className="text-muted">{d.noDocs}</p>}
                  {r.recent.map((x, i) => (
                    <div key={i} className="rounded-lg bg-surface-2/60 p-2.5">
                      <div className="text-xs text-muted">
                        {fmt.format(x.at)} · {x.contact || "—"} · {x.filename}
                      </div>
                      {x.summary && <div className="mt-1">{x.summary}</div>}
                      <div className="mt-1">
                        {r.fields
                          .filter((fl) => x.fields[fl.key])
                          .map((fl) => (
                            <div key={fl.key}>
                              <span className="text-muted">{fl.label}:</span> {x.fields[fl.key]}
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ),
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <FileText className="size-4 text-accent" />
            {d.outTitle}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">{d.outSubtitle}</p>
        </div>
        {editing !== "template" && (
          <Button onClick={() => setEditing("template")}>
            <Plus className="size-4" />
            {d.newTemplate}
          </Button>
        )}
        {editing === "template" && <TemplateEditor clientId={clientId} initial={{ name: "", purpose: "", body: d.bodyExample, fields: [], enabled: true }} onDone={() => setEditing(null)} />}
        {templates.length === 0 && editing !== "template" && <EmptyState icon={<FileText />} text={d.templatesEmpty} />}
        {templates.map((r) =>
          editing === r.id ? (
            <TemplateEditor key={r.id} clientId={clientId} id={r.id} initial={r} onDone={() => setEditing(null)} />
          ) : (
            <Card key={r.id} className="p-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.name}</span>
                    {!r.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
                  </div>
                  {r.purpose && <p className="mt-1 text-sm text-muted">{r.purpose}</p>}
                  <p className="mt-1 text-xs text-muted">
                    {r.fields.map((x) => x.label).join(" · ") || "—"}
                    {r.usedBy.length > 0 && ` · ${t.tools.usedBy}: ${r.usedBy.join(", ")}`}
                  </p>
                  <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    {d.issued.replace("{n}", String(r.counter))}
                  </button>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" title={d.edit} onClick={() => setEditing(r.id)}>
                    <Pencil className="size-4" />
                  </Button>
                  <DeleteButton confirmText={d.confirmDeleteTemplate} onDelete={() => deleteDocTemplate(r.id)} />
                </div>
              </div>
              {open === r.id && (
                <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                  {r.recent.length === 0 && <p className="text-muted">{d.noDocs}</p>}
                  {r.recent.map((x) => (
                    <a key={x.id} href={`/d/${x.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-surface-2">
                      <ExternalLink className="size-3.5 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{x.title}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {x.contact || "—"} · {fmt.format(x.at)}
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </Card>
          ),
        )}
      </section>
    </div>
  );
}

function DeleteButton({ confirmText, onDelete }: { confirmText: string; onDelete: () => Promise<unknown> }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      title={t.documents.delete}
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

function TypeEditor({ clientId, id, initial, onDone }: { clientId: string; id?: string; initial: TypeDraft; onDone: () => void }) {
  const { t } = useI18n();
  const d = t.documents;
  const [v, setV] = useState<TypeDraft>({ name: initial.name, purpose: initial.purpose, fields: initial.fields, notify: initial.notify, enabled: initial.enabled, folder: initial.folder, nameTemplate: initial.nameTemplate });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof TypeDraft>(k: K, val: TypeDraft[K]) => setV({ ...v, [k]: val });
  const setField = (i: number, p: Partial<DocField>) => set("fields", v.fields.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const submit = () =>
    start(async () => {
      const r = await saveDocType(clientId, id ?? null, v);
      if (r.error) setError((d.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });
  return (
    <Card className="space-y-4 p-5">
      <Field label={d.typeName}>
        <Input value={v.name} maxLength={100} placeholder={d.typeNamePlaceholder} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label={d.typePurpose} hint={d.typePurposeHint}>
        <Textarea rows={2} value={v.purpose} maxLength={1000} placeholder={d.typePurposePlaceholder} onChange={(e) => set("purpose", e.target.value)} />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold">{d.extract}</div>
        {v.fields.map((x, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="min-w-56 flex-1" value={x.label} maxLength={100} placeholder={d.fieldLabel} onChange={(e) => setField(i, { label: e.target.value })} />
            <Input className="w-32 font-mono text-[13px]" value={x.key} maxLength={40} title={d.fieldKey} onChange={(e) => setField(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "_") })} />
            {v.fields.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => set("fields", v.fields.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            )}
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => set("fields", [...v.fields, newField(v.fields.length + 1)])}>
          <Plus className="size-4" />
          {d.addField}
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={d.folder} hint={d.folderHint}>
          <Input className="w-64" value={v.folder} maxLength={120} placeholder={v.name || d.folderPlaceholder} onChange={(e) => set("folder", e.target.value)} />
        </Field>
        <Field label={d.nameTemplate} hint={d.nameTemplateHint.replace("{keys}", v.fields.map((x) => `{{${x.key}}}`).join(" "))}>
          <Input className="w-96 font-mono text-[13px]" value={v.nameTemplate} maxLength={200} placeholder="{{date}} {{type}} {{field1}}" onChange={(e) => set("nameTemplate", e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.notify} onChange={(e) => set("notify", e.target.checked)} />
          {d.notify}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {d.enabled}
        </label>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !v.name.trim()} onClick={submit}>
          {d.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {d.cancel}
        </Button>
      </div>
    </Card>
  );
}

function TemplateEditor({ clientId, id, initial, onDone }: { clientId: string; id?: string; initial: TemplateDraft; onDone: () => void }) {
  const { t } = useI18n();
  const d = t.documents;
  const [v, setV] = useState<TemplateDraft>({ name: initial.name, purpose: initial.purpose, body: initial.body, fields: initial.fields, enabled: initial.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof TemplateDraft>(k: K, val: TemplateDraft[K]) => setV({ ...v, [k]: val });
  const labels = new Map(v.fields.map((f) => [f.key, f.label]));
  const keys = templateKeys(v.body);
  const setLabel = (key: string, label: string) => set("fields", [...keys.map((k) => ({ key: k, label: k === key ? label : (labels.get(k) ?? "") }))]);
  const submit = () =>
    start(async () => {
      const r = await saveDocTemplate(clientId, id ?? null, { ...v, fields: keys.map((k) => ({ key: k, label: labels.get(k)?.trim() || k })) });
      if (r.error) setError((d.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });
  return (
    <Card className="space-y-4 p-5">
      <Field label={d.templateName}>
        <Input value={v.name} maxLength={100} placeholder={d.templateNamePlaceholder} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label={d.templatePurpose} hint={d.typePurposeHint}>
        <Textarea rows={2} value={v.purpose} maxLength={1000} placeholder={d.templatePurposePlaceholder} onChange={(e) => set("purpose", e.target.value)} />
      </Field>
      <Field label={d.body} hint={d.bodyHint}>
        <Textarea rows={12} className="font-mono text-[13px]" value={v.body} maxLength={30_000} onChange={(e) => set("body", e.target.value)} />
      </Field>
      {keys.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">{d.templateFields}</div>
          <p className="text-xs text-muted">{d.templateFieldsHint}</p>
          {keys.map((k) => (
            <div key={k} className="flex flex-wrap items-center gap-2">
              <code className="w-36 shrink-0 font-mono text-xs text-muted">{`{{${k}}}`}</code>
              <Input className="min-w-56 flex-1" value={labels.get(k) ?? ""} maxLength={200} placeholder={d.fieldLabel} onChange={(e) => setLabel(k, e.target.value)} />
            </div>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {d.enabled}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !v.name.trim() || !v.body.trim()} onClick={submit}>
          {d.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {d.cancel}
        </Button>
      </div>
    </Card>
  );
}

/** Архив: загрузка пачки файлов, раскладка по папкам с едиными именами, скачивание. */
function ArchiveSection({ clientId, docs }: { clientId: string; docs: ArchivedDoc[] }) {
  const { t, locale } = useI18n();
  const d = t.documents;
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short" });
  const shown = docs.filter((x) => !q.trim() || `${x.title} ${x.folder} ${x.summary}`.toLowerCase().includes(q.trim().toLowerCase()));
  const folders = [...new Set(shown.map((x) => x.folder || d.otherFolder))].sort((a, b) => a.localeCompare(b));
  const upload = () =>
    start(async () => {
      const files = [...(input.current?.files ?? [])];
      if (!files.length) return;
      const body = new FormData();
      body.set("clientId", clientId);
      files.forEach((f) => body.append("files", f));
      setMsg(null);
      const res = await fetch("/api/documents/archive", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string; file?: string; saved?: number };
      if (!res.ok || json.error) setMsg({ ok: false, text: `${(d.archiveErrors as Record<string, string>)[json.error ?? ""] ?? d.archiveErrors.failed}${json.file ? `: ${json.file}` : ""}` });
      else setMsg({ ok: true, text: d.archived.replace("{n}", String(json.saved ?? 0)) });
      if (input.current) input.current.value = "";
      router.refresh();
    });
  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Archive className="size-4 text-accent" />
          {d.archiveTitle}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{d.archiveSubtitle}</p>
      </div>
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <input ref={input} type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.html,.htm,.json,.xlsx,.jpg,.jpeg,.png" className="min-w-64 flex-1 text-sm" />
        <Button disabled={pending} onClick={upload}>
          {pending ? <Spinner /> : <Upload className="size-4" />}
          {d.archiveUpload}
        </Button>
        {msg && <p className={msg.ok ? "w-full text-sm text-success" : "w-full text-sm text-danger"}>{msg.text}</p>}
      </Card>
      {docs.length > 0 && <Input className="w-72" value={q} placeholder={d.archiveSearch} onChange={(e) => setQ(e.target.value)} />}
      {docs.length === 0 ? (
        <EmptyState icon={<Archive />} text={d.archiveEmpty} />
      ) : (
        <div className="space-y-2">
          {folders.map((f) => {
            const list = shown.filter((x) => (x.folder || d.otherFolder) === f);
            return (
              <Card key={f} className="p-0">
                <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold" onClick={() => setOpen(open === f ? null : f)}>
                  <Folder className="size-4 text-accent" />
                  <span className="flex-1">{f}</span>
                  <Badge tone="neutral">{list.length}</Badge>
                </button>
                {(open === f || q.trim()) && (
                  <div className="divide-y divide-border border-t border-border text-sm">
                    {list.map((x) => (
                      <div key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                        <FileText className="size-4 shrink-0 text-muted" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{x.title}</div>
                          <div className="truncate text-xs text-muted">
                            {fmt.format(x.at)}
                            {x.contact && ` · ${x.contact}`}
                            {x.summary && ` · ${x.summary}`}
                          </div>
                        </div>
                        {x.file && (
                          <a href={`/api/documents/file/${x.id}`} className={buttonClass("ghost", "sm")} title={d.download}>
                            <Download className="size-4" />
                          </a>
                        )}
                        <DeleteButton confirmText={d.confirmDeleteDoc} onDelete={() => deleteArchivedDoc(x.id)} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
