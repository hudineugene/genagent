"use client";

import { useState, useTransition } from "react";
import { Pencil, Play, Plus, Trash2, Wrench, X } from "lucide-react";
import { deleteTool, saveTool, testTool } from "@/app/actions/tools";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, cx } from "@/components/ui";
import type { ToolParam } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

export type ToolRow = {
  id: string;
  kind: "http" | "sheet";
  sheet: string | null;
  title: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  params: ToolParam[];
  readOnly: boolean;
  enabled: boolean;
  lastStatus: string | null;
  lastUsedAt: Date | null;
  /** Имена агентов, у которых инструмент включён */
  usedBy: string[];
};

type Draft = Omit<ToolRow, "id" | "headers" | "lastStatus" | "lastUsedAt" | "usedBy" | "sheet"> & { headers: string; sheet: string };

const EMPTY: Draft = { kind: "http", sheet: "", title: "", name: "", description: "", method: "GET", url: "", headers: "", params: [], readOnly: true, enabled: true };

const toDraft = (r: ToolRow): Draft => ({
  ...r,
  sheet: r.sheet ?? "",
  headers: Object.entries(r.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n"),
});

/** «Authorization: Bearer sk-…» → «Authorization: Bearer sk-…••••» — ключи в списке не показываем целиком. */
const mask = (v: string) => (v.length > 8 ? `${v.slice(0, 6)}••••` : "••••");

export function ToolsManager({ clientId, tools, googleEmail, children }: { clientId: string; tools: ToolRow[]; googleEmail: string | null; children?: React.ReactNode }) {
  const { t, locale } = useI18n();
  const tt = t.tools;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">{tt.subtitle}</p>
        {editing !== "new" && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            {tt.add}
          </Button>
        )}
      </div>

      {editing === "new" && <ToolForm clientId={clientId} initial={EMPTY} googleEmail={googleEmail} onDone={() => setEditing(null)} />}

      {tools.length === 0 && editing !== "new" ? (
        <EmptyState icon={<Wrench />} text={tt.empty} />
      ) : (
        tools.map((r) =>
          editing === r.id ? (
            <ToolForm key={r.id} clientId={clientId} id={r.id} initial={toDraft(r)} googleEmail={googleEmail} onDone={() => setEditing(null)} />
          ) : (
            <Card key={r.id} className="p-5">
              <div className="flex flex-wrap items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
                  <Wrench className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.title}</span>
                    <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{r.name}</code>
                    {!r.enabled && <Badge tone="neutral">{t.status.paused}</Badge>}
                    {r.readOnly && <Badge tone="success">{tt.readOnly}</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{r.description}</p>
                  <p className="mt-2 break-all font-mono text-xs text-muted">
                    {r.kind === "sheet" ? `${tt.kinds.sheet} · ${r.sheet ?? ""} · ` : `${r.method} `}
                    {r.url}
                    {Object.entries(r.headers).map(([k, v]) => (
                      <span key={k} className="block">
                        {k}: {mask(v)}
                      </span>
                    ))}
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    {tt.lastUsed}: {r.lastUsedAt ? `${fmt.format(r.lastUsedAt)} · ${r.lastStatus ?? "—"}` : tt.never}
                    {r.usedBy.length > 0 && ` · ${tt.usedBy}: ${r.usedBy.join(", ")}`}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button variant="secondary" size="sm" onClick={() => setTesting(testing === r.id ? null : r.id)}>
                    <Play className="size-4" />
                    {tt.test}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(r.id)} title={tt.edit}>
                    <Pencil className="size-4" />
                  </Button>
                  <DeleteButton id={r.id} />
                </div>
              </div>
              {testing === r.id && <TestPanel tool={r} onClose={() => setTesting(null)} />}
            </Card>
          ),
        )
      )}
      {children}
    </div>
  );
}

function DeleteButton({ id }: { id: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      title={t.tools.delete}
      onClick={async () => {
        if (await ask(t.tools.confirmDelete)) start(() => deleteTool(id));
      }}
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

function TestPanel({ tool, onClose }: { tool: ToolRow; onClose: () => void }) {
  const { t } = useI18n();
  const tt = t.tools;
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const errorText = (code: string) => (tt.errors as Record<string, string>)[code.split(":")[0]] ?? code;
  return (
    <div className="mt-4 space-y-3 rounded-xl border border-border bg-surface-2/50 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{tt.testTitle}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted">{tt.testHint}</p>
      {(tool.kind === "sheet" ? [{ name: "query", type: "string" as const, description: tt.query, required: true }] : tool.params).map((p) => (
        <Field key={p.name} label={`${p.name}${p.required ? " *" : ""}`} hint={p.description}>
          <Input value={values[p.name] ?? ""} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
        </Field>
      ))}
      <Button size="sm" disabled={pending} onClick={() => start(async () => setResult(await testTool(tool.id, values)))}>
        <Play className="size-4" />
        {tt.testRun}
      </Button>
      {result && (
        <pre className={cx("max-h-72 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs", result.ok ? "bg-surface" : "bg-danger/10 text-danger")}>
          {result.ok ? result.text : errorText(result.text)}
        </pre>
      )}
    </div>
  );
}

function ToolForm({ clientId, id, initial, googleEmail, onDone }: { clientId: string; id?: string; initial: Draft; googleEmail: string | null; onDone: () => void }) {
  const { t } = useI18n();
  const tt = t.tools;
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const setParam = (i: number, p: Partial<ToolParam>) => set("params", d.params.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const submit = () =>
    start(async () => {
      const r = await saveTool(clientId, id ?? null, d);
      if (r.error) setError((tt.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });

  const sheet = d.kind === "sheet";
  return (
    <Card className="space-y-4 p-5">
      <Field label={tt.kindLabel}>
        <Select className="max-w-xs" value={d.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
          <option value="http">{tt.kinds.http}</option>
          <option value="sheet">{tt.kinds.sheet}</option>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tt.titleLabel}>
          <Input value={d.title} maxLength={100} placeholder={tt.titlePlaceholder} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label={tt.nameLabel} hint={tt.nameHint}>
          <Input value={d.name} maxLength={40} placeholder="order_status" className="font-mono" onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
        </Field>
      </div>
      <Field label={tt.descriptionLabel} hint={tt.descriptionHint}>
        <Textarea rows={2} value={d.description} maxLength={1200} placeholder={sheet ? tt.sheetDescriptionPlaceholder : tt.descriptionPlaceholder} onChange={(e) => set("description", e.target.value)} />
      </Field>
      {sheet ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <Field label={tt.sheetUrl}>
            <Input value={d.url} maxLength={1000} placeholder="https://docs.google.com/spreadsheets/d/…" className="font-mono text-[13px]" onChange={(e) => set("url", e.target.value)} />
          </Field>
          <Field label={tt.sheetName}>
            <Input value={d.sheet} maxLength={100} placeholder="Лист1" onChange={(e) => set("sheet", e.target.value)} />
          </Field>
          <p className="text-xs text-muted sm:col-span-2">
            {googleEmail ? (
              <>
                {tt.sheetShare} <code className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono">{googleEmail}</code>
              </>
            ) : (
              tt.sheetNoGoogle
            )}
          </p>
        </div>
      ) : (
      <>
      <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
        <Field label={tt.method}>
          <Select value={d.method} onChange={(e) => set("method", e.target.value as Draft["method"])}>
            {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field label={tt.url} hint={tt.urlHint}>
          <Input value={d.url} maxLength={1000} placeholder="https://api.example.com/orders/{order_id}" className="font-mono text-[13px]" onChange={(e) => set("url", e.target.value)} />
        </Field>
      </div>
      <Field label={tt.headers} hint={tt.headersHint}>
        <Textarea rows={2} value={d.headers} placeholder="Authorization: Bearer …" className="font-mono text-[13px]" onChange={(e) => set("headers", e.target.value)} />
      </Field>
      <Field label={tt.params} hint={tt.paramsHint}>
        <div className="space-y-2">
          {d.params.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="w-40 font-mono text-[13px]" value={p.name} placeholder={tt.paramName} onChange={(e) => setParam(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "_") })} />
              <Select className="w-28" value={p.type} onChange={(e) => setParam(i, { type: e.target.value as ToolParam["type"] })}>
                {(["string", "number", "boolean"] as const).map((x) => (
                  <option key={x} value={x}>
                    {tt.types[x]}
                  </option>
                ))}
              </Select>
              <Input className="min-w-48 flex-1" value={p.description} placeholder={tt.paramDesc} onChange={(e) => setParam(i, { description: e.target.value })} />
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} />
                {tt.paramRequired}
              </label>
              <Button variant="ghost" size="sm" onClick={() => set("params", d.params.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={() => set("params", [...d.params, { name: "", type: "string", description: "", required: true }])}>
            <Plus className="size-4" />
            {tt.addParam}
          </Button>
        </div>
      </Field>
      </>
      )}
      <div className="flex flex-wrap gap-6">
        {!sheet && (
        <label className="flex max-w-md items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={d.readOnly} onChange={(e) => set("readOnly", e.target.checked)} />
          <span>
            {tt.readOnly}
            <span className="block text-xs text-muted">{tt.readOnlyHint}</span>
          </span>
        </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {tt.enabled}
        </label>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !d.title.trim() || !d.name || !d.url.trim()} onClick={submit}>
          {tt.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {tt.cancel}
        </Button>
      </div>
    </Card>
  );
}
