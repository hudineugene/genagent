"use client";

import { useState, useTransition } from "react";
import { ClipboardList, Download, GraduationCap, Pencil, Plus, Trash2, X } from "lucide-react";
import { deleteForm, saveForm } from "@/app/actions/forms";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, buttonClass } from "@/components/ui";
import type { FormField } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

type Kind = "form" | "quiz";
export type FormRow = {
  id: string;
  kind: Kind;
  name: string;
  purpose: string;
  fields: FormField[];
  thanks: string;
  notify: boolean;
  enabled: boolean;
  total: number;
  /** Последние ответы: дата, клиент, ответы по ключам, баллы */
  recent: { at: number; contact: string; answers: Record<string, string>; score: number | null; maxScore: number | null }[];
  usedBy: string[];
};
type Draft = Pick<FormRow, "kind" | "name" | "purpose" | "fields" | "thanks" | "notify" | "enabled">;

const TYPES = ["text", "choice", "number", "phone", "email", "rating", "date"] as const;
const newField = (n: number): FormField => ({ key: `q${n}`, label: "", type: "text", required: true });
const empty = (kind: Kind): Draft => ({ kind, name: "", purpose: "", fields: [newField(1)], thanks: "", notify: true, enabled: true });

export function FormsManager({ clientId, rows }: { clientId: string; rows: FormRow[] }) {
  const { t, locale } = useI18n();
  const f = t.forms;
  const [editing, setEditing] = useState<string | Kind | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{f.subtitle}</p>
      {editing !== "form" && editing !== "quiz" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing("form")}>
            <ClipboardList className="size-4" />
            {f.newForm}
          </Button>
          <Button variant="secondary" onClick={() => setEditing("quiz")}>
            <GraduationCap className="size-4" />
            {f.newQuiz}
          </Button>
        </div>
      )}
      {(editing === "form" || editing === "quiz") && <FormEditor clientId={clientId} initial={empty(editing)} onDone={() => setEditing(null)} />}
      {rows.length === 0 && editing === null && <EmptyState icon={<ClipboardList />} text={f.empty} action={<Button variant="secondary" onClick={() => setEditing("form")}><ClipboardList className="size-4" />{f.newForm}</Button>} />}
      {rows.map((r) =>
        editing === r.id ? (
          <FormEditor key={r.id} clientId={clientId} id={r.id} initial={r} onDone={() => setEditing(null)} />
        ) : (
          <Card key={r.id} className="p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
                {r.kind === "quiz" ? <GraduationCap className="size-5" /> : <ClipboardList className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <Badge tone="neutral">{f.kinds[r.kind]}</Badge>
                  {!r.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
                </div>
                {r.purpose && <p className="mt-1 text-sm text-muted">{r.purpose}</p>}
                <p className="mt-1 text-xs text-muted">
                  {r.fields.map((x) => x.label).join(" · ")}
                  {r.usedBy.length > 0 && ` · ${t.tools.usedBy}: ${r.usedBy.join(", ")}`}
                </p>
                <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {f.responses.replace("{n}", String(r.total))}
                </button>
              </div>
              <div className="flex gap-1">
                {r.total > 0 && (
                  <a href={`/api/forms/${r.id}/csv`} className={buttonClass("secondary", "sm")}>
                    <Download className="size-4" />
                    {f.download}
                  </a>
                )}
                <Button variant="ghost" size="sm" title={f.edit} onClick={() => setEditing(r.id)}>
                  <Pencil className="size-4" />
                </Button>
                <DeleteButton id={r.id} />
              </div>
            </div>
            {open === r.id && (
              <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
                <div className="text-xs font-medium text-muted">{f.last}</div>
                {r.recent.length === 0 && <p className="text-muted">{f.noResponses}</p>}
                {r.recent.map((x, i) => (
                  <div key={i} className="rounded-lg bg-surface-2/60 p-2.5">
                    <div className="text-xs text-muted">
                      {fmt.format(x.at)} · {x.contact || "—"}
                      {x.score != null && ` · ${f.score}: ${x.score}/${x.maxScore}`}
                    </div>
                    <div className="mt-1">
                      {r.fields
                        .filter((fl) => x.answers[fl.key])
                        .map((fl) => (
                          <div key={fl.key}>
                            <span className="text-muted">{fl.label}:</span> {x.answers[fl.key]}
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
    </div>
  );
}

function DeleteButton({ id }: { id: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" disabled={pending} title={t.forms.delete} onClick={async () => await ask(t.forms.confirmDelete) && start(() => deleteForm(id))}>
      <Trash2 className="size-4" />
    </Button>
  );
}

function FormEditor({ clientId, id, initial, onDone }: { clientId: string; id?: string; initial: Draft; onDone: () => void }) {
  const { t } = useI18n();
  const f = t.forms;
  const [d, setD] = useState<Draft>({ kind: initial.kind, name: initial.name, purpose: initial.purpose, fields: initial.fields, thanks: initial.thanks, notify: initial.notify, enabled: initial.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const setField = (i: number, p: Partial<FormField>) => set("fields", d.fields.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const quiz = d.kind === "quiz";
  const submit = () =>
    start(async () => {
      const r = await saveForm(clientId, id ?? null, d);
      if (r.error) setError((f.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-2 font-semibold">
        {quiz ? <GraduationCap className="size-4 text-accent" /> : <ClipboardList className="size-4 text-accent" />}
        {f.kinds[d.kind]}
      </div>
      <Field label={f.name}>
        <Input value={d.name} maxLength={100} placeholder={f.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label={f.purpose} hint={f.purposeHint}>
        <Textarea rows={2} value={d.purpose} maxLength={1000} placeholder={f.purposePlaceholder} onChange={(e) => set("purpose", e.target.value)} />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold">{f.fields}</div>
        {d.fields.map((x, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="min-w-56 flex-1" value={x.label} maxLength={200} placeholder={f.fieldLabel} onChange={(e) => setField(i, { label: e.target.value })} />
              <Input className="w-28 font-mono text-[13px]" value={x.key} maxLength={40} title={f.fieldKey} onChange={(e) => setField(i, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "_") })} />
              <Select className="w-36" value={x.type} title={f.fieldType} onChange={(e) => setField(i, { type: e.target.value as FormField["type"] })}>
                {TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {f.types[ty]}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={x.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                {f.required}
              </label>
              {d.fields.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => set("fields", d.fields.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
            {x.type === "choice" && (
              <Input
                value={(x.options ?? []).join(", ")}
                placeholder={f.options}
                onChange={(e) =>
                  setField(i, {
                    options: e.target.value
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean),
                  })
                }
              />
            )}
            {quiz && (
              <div className="flex flex-wrap items-center gap-2">
                <Input className="min-w-56 flex-1" value={x.correct ?? ""} maxLength={200} placeholder={f.correct} onChange={(e) => setField(i, { correct: e.target.value })} />
                <Input type="number" min={0} className="w-24" value={x.points ?? 1} title={f.points} onChange={(e) => setField(i, { points: Math.max(0, Number(e.target.value) || 0) })} />
                <span className="text-xs text-muted">{f.points}</span>
              </div>
            )}
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => set("fields", [...d.fields, newField(d.fields.length + 1)])}>
          <Plus className="size-4" />
          {f.addField}
        </Button>
      </div>
      <Field label={f.thanks}>
        <Input value={d.thanks} maxLength={1000} placeholder={f.thanksPlaceholder} onChange={(e) => set("thanks", e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.notify} onChange={(e) => set("notify", e.target.checked)} />
          {f.notify}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {f.enabled}
        </label>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !d.name.trim()} onClick={submit}>
          {f.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {f.cancel}
        </Button>
      </div>
    </Card>
  );
}
