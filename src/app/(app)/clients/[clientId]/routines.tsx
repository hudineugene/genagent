"use client";

import { useState, useTransition } from "react";
import { BarChart3, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { deleteRoutine, runRoutineNow, saveRoutine } from "@/app/actions/routines";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea, cx } from "@/components/ui";
import type { RoutineDelivery, RoutineSchedule, RoutineSource } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

export type RoutineRow = {
  id: string;
  name: string;
  task: string;
  schedule: RoutineSchedule;
  sources: RoutineSource[];
  delivery: RoutineDelivery;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastResult: string | null;
};
type Draft = Pick<RoutineRow, "name" | "task" | "schedule" | "sources" | "delivery" | "enabled">;

const EMPTY: Draft = {
  name: "",
  task: "",
  schedule: { freq: "weekly", hour: 9, weekday: 1 },
  sources: [{ type: "conversations", days: 7 }],
  delivery: { team: true, owners: false },
  enabled: true,
};
const SOURCE_TYPES = ["conversations", "table", "sheet", "url", "search"] as const;
type TableOption = { id: string; name: string };
const newSource = (type: RoutineSource["type"], tables: TableOption[] = []): RoutineSource =>
  type === "conversations"
    ? { type, days: 7 }
    : type === "table"
      ? { type, tableId: tables[0]?.id ?? "" }
      : type === "sheet"
        ? { type, url: "", sheet: "Лист1" }
        : type === "url"
          ? { type, url: "" }
          : { type, query: "" };

export function RoutinesManager({ clientId, rows, tables = [] }: { clientId: string; rows: RoutineRow[]; tables?: TableOption[] }) {
  const { t, locale } = useI18n();
  const r = t.routines;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const when = (s: RoutineSchedule) =>
    `${r.freqs[s.freq]}${s.freq === "weekly" ? ` (${r.weekdays[s.weekday ?? 1]})` : s.freq === "monthly" ? ` (${s.day ?? 1})` : ""}, ${String(s.hour).padStart(2, "0")}:00`;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{r.subtitle}</p>
      {editing !== "new" && (
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {r.new}
        </Button>
      )}
      {editing === "new" && <RoutineForm clientId={clientId} tables={tables} initial={EMPTY} onDone={() => setEditing(null)} />}
      {rows.length === 0 && editing !== "new" && <EmptyState icon={<BarChart3 />} text={r.empty} />}
      {rows.map((x) =>
        editing === x.id ? (
          <RoutineForm key={x.id} clientId={clientId} tables={tables} id={x.id} initial={x} onDone={() => setEditing(null)} />
        ) : (
          <RoutineCard key={x.id} row={x} when={when(x.schedule)} last={x.lastRunAt ? `${fmt.format(x.lastRunAt)} · ${x.lastStatus ?? ""}` : r.never} onEdit={() => setEditing(x.id)} />
        ),
      )}
    </div>
  );
}

function RoutineCard({ row, when, last, onEdit }: { row: RoutineRow; when: string; last: string; onEdit: () => void }) {
  const { t } = useI18n();
  const r = t.routines;
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
          <BarChart3 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.name}</span>
            <Badge tone={row.enabled ? "success" : "warning"}>{row.enabled ? when : t.status.paused}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted">{row.task}</p>
          <p className="mt-1 text-xs text-muted">{row.sources.map((s) => r.sourceTypes[s.type]).join(" · ")}</p>
          <p className={cx("mt-1 text-xs", row.lastStatus?.startsWith("error") ? "text-danger" : "text-muted")}>
            {r.last}: {last}
          </p>
          {!result && row.lastResult && (
            <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => setResult(row.lastResult)}>
              {r.showLast}
            </button>
          )}
          {pending && (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <Spinner /> {r.running}
            </p>
          )}
          {result && (
            <div className="mt-2 rounded-lg bg-surface-2 p-3 text-sm">
              <button type="button" className="float-right text-muted" onClick={() => setResult(null)} aria-label="×">
                <X className="size-4" />
              </button>
              <p className="whitespace-pre-wrap">{result}</p>
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(async () => setResult((await runRoutineNow(row.id)).text))}>
            <Play className="size-4" />
            {r.runNow}
          </Button>
          <Button variant="ghost" size="sm" title={r.edit} onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} title={r.delete} onClick={async () => await ask(r.confirmDelete) && start(() => deleteRoutine(row.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RoutineForm({ clientId, tables, id, initial, onDone }: { clientId: string; tables: TableOption[]; id?: string; initial: Draft; onDone: () => void }) {
  const { t } = useI18n();
  const r = t.routines;
  const [d, setD] = useState<Draft>({ name: initial.name, task: initial.task, schedule: initial.schedule, sources: initial.sources, delivery: initial.delivery, enabled: initial.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const sched = (p: Partial<RoutineSchedule>) => set("schedule", { ...d.schedule, ...p });
  const setSource = (i: number, s: RoutineSource) => set("sources", d.sources.map((x, j) => (j === i ? s : x)));
  const submit = () =>
    start(async () => {
      const res = await saveRoutine(clientId, id ?? null, d);
      if (res.error) setError((r.errors as Record<string, string>)[res.error] ?? res.error);
      else onDone();
    });

  return (
    <Card className="space-y-4 p-5">
      <Field label={r.name}>
        <Input value={d.name} maxLength={100} placeholder={r.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <Field label={r.task}>
        <Textarea rows={3} value={d.task} maxLength={3000} placeholder={r.taskPlaceholder} onChange={(e) => set("task", e.target.value)} />
      </Field>
      <Field label={r.schedule}>
        <div className="flex flex-wrap gap-2">
          <Select className="w-44" value={d.schedule.freq} onChange={(e) => sched({ freq: e.target.value as RoutineSchedule["freq"] })}>
            {(["daily", "weekly", "monthly"] as const).map((f) => (
              <option key={f} value={f}>
                {r.freqs[f]}
              </option>
            ))}
          </Select>
          {d.schedule.freq === "weekly" && (
            <Select className="w-24" title={r.weekday} value={d.schedule.weekday ?? 1} onChange={(e) => sched({ weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 0].map((w) => (
                <option key={w} value={w}>
                  {r.weekdays[w]}
                </option>
              ))}
            </Select>
          )}
          {d.schedule.freq === "monthly" && (
            <Input type="number" min={1} max={31} className="w-24" title={r.day} value={d.schedule.day ?? 1} onChange={(e) => sched({ day: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} />
          )}
          <Select className="w-28" title={r.hour} value={d.schedule.hour} onChange={(e) => sched({ hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </div>
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold">{r.sources}</div>
        {d.sources.map((s, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-xl border border-border p-3">
            <Select className="w-52" value={s.type} onChange={(e) => setSource(i, newSource(e.target.value as RoutineSource["type"], tables))}>
              {SOURCE_TYPES.filter((x) => x !== "table" || tables.length || s.type === "table").map((x) => (
                <option key={x} value={x}>
                  {r.sourceTypes[x]}
                </option>
              ))}
            </Select>
            {s.type === "conversations" && (
              <Field label={r.days}>
                <Input type="number" min={1} max={90} className="w-24" value={s.days} onChange={(e) => setSource(i, { ...s, days: Math.min(90, Math.max(1, Number(e.target.value) || 7)) })} />
              </Field>
            )}
            {s.type === "table" && (
              <Select className="min-w-64 flex-1" value={s.tableId} onChange={(e) => setSource(i, { ...s, tableId: e.target.value })}>
                {tables.map((tb) => (
                  <option key={tb.id} value={tb.id}>
                    {tb.name}
                  </option>
                ))}
              </Select>
            )}
            {s.type === "sheet" && (
              <>
                <Input className="min-w-64 flex-1 font-mono text-[13px]" placeholder={r.sheetUrl} value={s.url} onChange={(e) => setSource(i, { ...s, url: e.target.value })} />
                <Input className="w-32" placeholder={r.sheet} value={s.sheet} onChange={(e) => setSource(i, { ...s, sheet: e.target.value })} />
              </>
            )}
            {s.type === "url" && <Input className="min-w-64 flex-1 font-mono text-[13px]" placeholder={r.url} value={s.url} onChange={(e) => setSource(i, { ...s, url: e.target.value })} />}
            {s.type === "search" && (
              <div className="min-w-64 flex-1">
                <Input placeholder={r.query} value={s.query} onChange={(e) => setSource(i, { ...s, query: e.target.value })} />
                <p className="mt-1 text-xs text-muted">{r.searchHint}</p>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => set("sources", d.sources.filter((_, j) => j !== i))}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        {d.sources.length < 10 && (
          <Button variant="secondary" size="sm" onClick={() => set("sources", [...d.sources, newSource("url")])}>
            <Plus className="size-4" />
            {r.addSource}
          </Button>
        )}
      </div>
      <Field label={r.deliveryTitle}>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.delivery.team} onChange={(e) => set("delivery", { ...d.delivery, team: e.target.checked })} />
            {r.team}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.delivery.owners} onChange={(e) => set("delivery", { ...d.delivery, owners: e.target.checked })} />
            {r.owners}
          </label>
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {r.enabled}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !d.name.trim() || !d.task.trim()} onClick={submit}>
          {r.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {r.cancel}
        </Button>
      </div>
    </Card>
  );
}
