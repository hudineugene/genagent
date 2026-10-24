"use client";

import { useState, useTransition } from "react";
import { Activity, Copy, KeyRound, Megaphone, Pencil, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { checkMonitorNow, closeIncident, deleteMonitor, incidentToCampaign, renewMonitorKey, saveMonitor } from "@/app/actions/monitor";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea, cx } from "@/components/ui";

export type MonitorRow = {
  id: string;
  name: string;
  kind: "http" | "webhook";
  url: string;
  expectText: string;
  maxMs: number;
  intervalMin: number;
  failThreshold: number;
  audience: string;
  enabled: boolean;
  status: "unknown" | "up" | "down";
  lastCheckAt: number | null;
  lastMs: number | null;
  lastError: string | null;
  apiKey: string;
};
export type IncidentRow = { id: string; monitorId: string; monitor: string; error: string; draft: string; resolvedDraft: string; status: "open" | "resolved"; campaignId: string | null; startedAt: number; resolvedAt: number | null };
type Draft = Omit<MonitorRow, "id" | "status" | "lastCheckAt" | "lastMs" | "lastError" | "apiKey">;

const EMPTY: Draft = { name: "", kind: "http", url: "", expectText: "", maxMs: 10000, intervalMin: 5, failThreshold: 2, audience: "", enabled: true };

export function MonitorManager({ clientId, rows, incidents, apiBase }: { clientId: string; rows: MonitorRow[]; incidents: IncidentRow[]; apiBase: string }) {
  const { t } = useI18n();
  const m = t.monitor;
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{m.subtitle}</p>
      {incidents.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">{m.incidents}</h2>
          {incidents.map((x) => (
            <IncidentCard key={x.id} row={x} clientId={clientId} />
          ))}
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">{m.checks}</h2>
        {editing !== "new" && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            {m.new}
          </Button>
        )}
        {editing === "new" && <MonitorForm clientId={clientId} initial={EMPTY} onDone={() => setEditing(null)} />}
        {rows.length === 0 && editing !== "new" && <EmptyState icon={<Activity />} text={m.empty} />}
        {rows.map((r) =>
          editing === r.id ? <MonitorForm key={r.id} clientId={clientId} id={r.id} initial={r} onDone={() => setEditing(null)} /> : <MonitorCard key={r.id} row={r} apiBase={apiBase} onEdit={() => setEditing(r.id)} />,
        )}
      </section>
    </div>
  );
}

function MonitorCard({ row, apiBase, onEdit }: { row: MonitorRow; apiBase: string; onEdit: () => void }) {
  const { t, locale } = useI18n();
  const m = t.monitor;
  const [pending, start] = useTransition();
  const [show, setShow] = useState(false);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const tone = row.status === "up" ? "success" : row.status === "down" ? "warning" : "neutral";
  const url = `${apiBase}/api/monitor/${row.id}`;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className={cx("mt-1.5 size-2.5 shrink-0 rounded-full", row.status === "up" ? "bg-success" : row.status === "down" ? "bg-danger" : "bg-border")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.name}</span>
            <Badge tone={tone}>{row.enabled ? m.statuses[row.status] : t.status.paused}</Badge>
            <span className="text-xs text-muted">{m.kinds[row.kind]}</span>
          </div>
          {row.kind === "http" && (
            <p className="mt-1 truncate font-mono text-xs text-muted">
              {row.url} · {m.every.replace("{n}", String(row.intervalMin))}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            {row.lastCheckAt ? `${m.last}: ${fmt.format(row.lastCheckAt)}${row.lastMs != null && row.kind === "http" ? ` · ${row.lastMs} мс` : ""}` : m.never}
            {row.lastError && <span className="text-danger"> · {row.lastError}</span>}
          </p>
          {row.kind === "webhook" && (
            <div className="mt-2 space-y-1 rounded-lg bg-surface-2/60 p-2 text-xs">
              <div className="flex items-center gap-1 font-semibold">
                <KeyRound className="size-3.5" />
                {m.webhookTitle}
              </div>
              <pre className="overflow-x-auto font-mono">{`curl -X POST ${url} \\\n  -H "Authorization: Bearer ${show ? row.apiKey : "mn_••••••"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"errors": 37, "threshold": 10}'`}</pre>
              <div className="flex gap-2">
                <button type="button" className="text-accent hover:underline" onClick={() => setShow(!show)}>
                  {show ? m.hideKey : m.showKey}
                </button>
                <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void navigator.clipboard.writeText(row.apiKey)}>
                  <Copy className="size-3" />
                  {m.copyKey}
                </button>
                <button type="button" className="text-accent hover:underline" onClick={() => confirm(m.confirmRenew) && start(() => renewMonitorKey(row.id))}>
                  {m.renewKey}
                </button>
              </div>
              <p className="text-muted">{m.webhookHint}</p>
            </div>
          )}
        </div>
        {row.kind === "http" && (
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(async () => void (await checkMonitorNow(row.id)))}>
            {pending ? <Spinner /> : <Play className="size-4" />}
            {m.checkNow}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => confirm(m.confirmDelete) && start(() => deleteMonitor(row.id))}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

function MonitorForm({ clientId, id, initial, onDone }: { clientId: string; id?: string; initial: Draft; onDone: () => void }) {
  const { t } = useI18n();
  const m = t.monitor;
  const [d, setD] = useState<Draft>({ name: initial.name, kind: initial.kind, url: initial.url, expectText: initial.expectText, maxMs: initial.maxMs, intervalMin: initial.intervalMin, failThreshold: initial.failThreshold, audience: initial.audience, enabled: initial.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap gap-3">
        <Field label={m.name}>
          <Input className="w-64" value={d.name} maxLength={100} placeholder={m.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={m.kind}>
          <Select className="w-64" value={d.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
            <option value="http">{m.kinds.http}</option>
            <option value="webhook">{m.kinds.webhook}</option>
          </Select>
        </Field>
      </div>
      {d.kind === "http" ? (
        <>
          <div className="flex flex-wrap gap-3">
            <Field label={m.url}>
              <Input className="w-96 font-mono text-[13px]" value={d.url} maxLength={1000} placeholder="https://shop.example.com/api/health" onChange={(e) => set("url", e.target.value)} />
            </Field>
            <Field label={m.expectText} hint={m.expectHint}>
              <Input className="w-56" value={d.expectText} maxLength={200} onChange={(e) => set("expectText", e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Field label={m.interval}>
              <Input type="number" min={1} max={1440} className="w-24" value={d.intervalMin} onChange={(e) => set("intervalMin", num(e.target.value, 1, 1440))} />
            </Field>
            <Field label={m.maxMs}>
              <Input type="number" min={500} max={60000} step={500} className="w-28" value={d.maxMs} onChange={(e) => set("maxMs", num(e.target.value, 500, 60000))} />
            </Field>
            <Field label={m.threshold} hint={m.thresholdHint}>
              <Input type="number" min={1} max={10} className="w-24" value={d.failThreshold} onChange={(e) => set("failThreshold", num(e.target.value, 1, 10))} />
            </Field>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">{m.webhookAbout}</p>
      )}
      <Field label={m.audience} hint={m.audienceHint}>
        <Textarea rows={2} value={d.audience} maxLength={500} placeholder={m.audiencePlaceholder} onChange={(e) => set("audience", e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {m.enabled}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.name.trim()}
          onClick={() =>
            start(async () => {
              const r = await saveMonitor(clientId, id ?? null, d);
              if (r.error) setError((m.errors as Record<string, string>)[r.error] ?? r.error);
              else onDone();
            })
          }
        >
          {m.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {m.cancel}
        </Button>
      </div>
    </Card>
  );
}

function IncidentCard({ row, clientId }: { row: IncidentRow; clientId: string }) {
  const { t, locale } = useI18n();
  const m = t.monitor;
  const [text, setText] = useState(row.status === "open" ? row.draft : row.resolvedDraft);
  const [days, setDays] = useState(7);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const which = row.status === "open" ? "draft" : "resolved";
  return (
    <Card className={cx("space-y-2 p-5", row.status === "open" && "border-danger/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={row.status === "open" ? "warning" : "success"}>{row.status === "open" ? m.open : m.resolved}</Badge>
        <span className="font-semibold">{row.monitor}</span>
        <span className="text-xs text-muted">
          {fmt.format(row.startedAt)}
          {row.resolvedAt && ` → ${fmt.format(row.resolvedAt)} (${Math.round((row.resolvedAt - row.startedAt) / 60_000)} ${m.min})`}
        </span>
        <span className="text-xs text-danger">{row.error}</span>
        <span className="flex-1" />
        {row.status === "open" && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => start(() => closeIncident(row.id))}>
            {m.close}
          </Button>
        )}
      </div>
      <Field label={row.status === "open" ? m.draft : m.resolvedDraft} hint={m.draftHint}>
        <Textarea rows={3} value={text} maxLength={3000} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{m.toWhom}</span>
        <Input type="number" min={1} max={90} className="w-20" value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 7)))} />
        <span className="text-sm">{m.days}</span>
        <Button
          size="sm"
          disabled={pending || text.trim().length < 10}
          onClick={() =>
            start(async () => {
              const r = await incidentToCampaign(row.id, text, days, which);
              setMsg(r.error ? { ok: false, text: m.errors.failed } : { ok: true, text: m.campaignCreated });
            })
          }
        >
          <Megaphone className="size-4" />
          {m.toCampaign}
        </Button>
        {(msg?.ok || row.campaignId) && (
          <Link href={`/clients/${clientId}?tab=campaigns`} className="text-sm text-accent hover:underline">
            {m.openCampaigns}
          </Link>
        )}
      </div>
      {msg && <p className={msg.ok ? "text-sm text-success" : "text-sm text-danger"}>{msg.text}</p>}
    </Card>
  );
}
