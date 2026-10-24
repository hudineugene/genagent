"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Pencil, RefreshCw, Send, Sheet, Sparkles, Table2, Trash2, Upload } from "lucide-react";
import { addSheetTable, askDataAction, deleteTable, refreshTableNow, saveTableMeta } from "@/app/actions/data";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, Textarea, cx } from "@/components/ui";
import type { DataColumn } from "@/db/schema";
import type { ChartSpec } from "@/lib/data/analyst";
import { ask as confirmAsk } from "@/components/confirm-dialog";

export type DataTableRow = {
  id: string;
  name: string;
  description: string;
  source: "file" | "sheet";
  sheetUrl: string;
  sheetName: string;
  filename: string;
  columns: DataColumn[];
  sample: string[][];
  rowCount: number;
  enabled: boolean;
  refreshedAt: number | null;
  error: string | null;
  usedBy: string[];
};

export function DataManager({ clientId, tables }: { clientId: string; tables: DataTableRow[] }) {
  const { t, locale } = useI18n();
  const d = t.data;
  const [adding, setAdding] = useState<"file" | "sheet" | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <p className="max-w-3xl text-sm text-muted">{d.subtitle}</p>
        {adding === null && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAdding("file")}>
              <Upload className="size-4" />
              {d.uploadFile}
            </Button>
            <Button variant="secondary" onClick={() => setAdding("sheet")}>
              <Sheet className="size-4" />
              {d.connectSheet}
            </Button>
          </div>
        )}
        {adding === "file" && <UploadForm clientId={clientId} onDone={() => setAdding(null)} />}
        {adding === "sheet" && <SheetForm clientId={clientId} onDone={() => setAdding(null)} />}
        {tables.length === 0 && adding === null && <EmptyState icon={<Table2 />} text={d.empty} action={<Button variant="secondary" onClick={() => setAdding("file")}><Upload className="size-4" />{d.uploadFile}</Button>} />}
        {tables.map((x) => (
          <TableCard key={x.id} clientId={clientId} row={x} refreshed={x.refreshedAt ? fmt.format(x.refreshedAt) : "—"} />
        ))}
      </section>
      {tables.some((x) => x.enabled) && <Analyst clientId={clientId} />}
    </div>
  );
}

function UploadForm({ clientId, tableId, onDone }: { clientId: string; tableId?: string; onDone: () => void }) {
  const { t } = useI18n();
  const d = t.data;
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sheet, setSheet] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const f = file.current?.files?.[0];
      if (!f) return setError(d.errors.no_file);
      const body = new FormData();
      body.set("clientId", clientId);
      body.set("file", f);
      if (tableId) body.set("tableId", tableId);
      else {
        body.set("name", name);
        body.set("description", description);
      }
      if (sheet.trim()) body.set("sheet", sheet.trim());
      const res = await fetch("/api/data/upload", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || json.error) return setError((d.errors as Record<string, string>)[json.error ?? ""] ?? d.errors.parse_failed);
      router.refresh();
      onDone();
    });
  return (
    <Card className="space-y-4 p-5">
      <Field label={d.file} hint={d.fileHint}>
        <input ref={file} type="file" accept=".csv,.tsv,.txt,.xlsx" className="block w-full text-sm" />
      </Field>
      <Field label={d.excelSheet} hint={d.excelSheetHint}>
        <Input className="w-56" value={sheet} maxLength={100} onChange={(e) => setSheet(e.target.value)} />
      </Field>
      {!tableId && (
        <>
          <Field label={d.name}>
            <Input value={name} maxLength={100} placeholder={d.namePlaceholder} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={d.description} hint={d.descriptionHint}>
            <Textarea rows={2} value={description} maxLength={1000} placeholder={d.descriptionPlaceholder} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={submit}>
          {pending ? <Spinner /> : <Upload className="size-4" />}
          {tableId ? d.replace : d.upload}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {d.cancel}
        </Button>
      </div>
    </Card>
  );
}

function SheetForm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const { t } = useI18n();
  const d = t.data;
  const [v, setV] = useState({ name: "", description: "", url: "", sheet: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await addSheetTable(clientId, v);
      if (r.error) setError((d.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });
  return (
    <Card className="space-y-4 p-5">
      <p className="text-xs text-muted">{d.sheetHint}</p>
      <Field label={d.sheetUrl}>
        <Input className="font-mono text-[13px]" value={v.url} maxLength={1000} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={(e) => setV({ ...v, url: e.target.value })} />
      </Field>
      <Field label={d.sheetName} hint={d.sheetNameHint}>
        <Input className="w-56" value={v.sheet} maxLength={100} onChange={(e) => setV({ ...v, sheet: e.target.value })} />
      </Field>
      <Field label={d.name}>
        <Input value={v.name} maxLength={100} placeholder={d.namePlaceholder} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </Field>
      <Field label={d.description} hint={d.descriptionHint}>
        <Textarea rows={2} value={v.description} maxLength={1000} placeholder={d.descriptionPlaceholder} onChange={(e) => setV({ ...v, description: e.target.value })} />
      </Field>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !v.url.trim() || !v.name.trim()} onClick={submit}>
          {pending ? <Spinner /> : <Sheet className="size-4" />}
          {d.connect}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {d.cancel}
        </Button>
      </div>
    </Card>
  );
}

function TableCard({ clientId, row, refreshed }: { clientId: string; row: DataTableRow; refreshed: string }) {
  const { t } = useI18n();
  const d = t.data;
  const [mode, setMode] = useState<"view" | "edit" | "replace" | "preview">("view");
  const [meta, setMeta] = useState({ name: row.name, description: row.description, enabled: row.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
          {row.source === "sheet" ? <Sheet className="size-5" /> : <FileSpreadsheet className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.name}</span>
            <Badge tone="neutral">{row.source === "sheet" ? d.sourceSheet : row.filename || d.sourceFile}</Badge>
            {!row.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
          </div>
          {row.description && <p className="mt-1 text-sm text-muted">{row.description}</p>}
          <p className="mt-1 text-xs text-muted">
            {d.rows.replace("{n}", String(row.rowCount))} · {row.columns.map((c) => c.name).join(", ")}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {d.refreshed}: {refreshed}
            {row.usedBy.length > 0 && ` · ${t.tools.usedBy}: ${row.usedBy.join(", ")}`}
          </p>
          {(row.error || error) && <p className="mt-1 text-xs text-danger">{error ?? row.error}</p>}
          <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={() => setMode(mode === "preview" ? "view" : "preview")}>
            {d.preview}
          </button>
        </div>
        <div className="flex gap-1">
          {row.source === "sheet" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await refreshTableNow(row.id);
                  setError(r.error ?? null);
                })
              }
            >
              {pending ? <Spinner /> : <RefreshCw className="size-4" />}
              {d.refresh}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setMode("replace")}>
              <Upload className="size-4" />
              {d.replace}
            </Button>
          )}
          <Button variant="ghost" size="sm" title={d.edit} onClick={() => setMode("edit")}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} title={d.delete} onClick={async () => await confirmAsk(d.confirmDelete) && start(() => deleteTable(row.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
      {mode === "preview" && (
        <div className="mt-3 overflow-x-auto border-t border-border pt-3">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {row.columns.map((c) => (
                  <th key={c.name} className="whitespace-nowrap px-2 py-1 font-semibold">
                    {c.name} <span className="font-normal text-muted">· {d.types[c.type]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row.sample.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {r.map((v, j) => (
                    <td key={j} className="max-w-48 truncate whitespace-nowrap px-2 py-1">
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mode === "replace" && (
        <div className="mt-3">
          <UploadForm clientId={clientId} tableId={row.id} onDone={() => setMode("view")} />
        </div>
      )}
      {mode === "edit" && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <Field label={d.name}>
            <Input value={meta.name} maxLength={100} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          </Field>
          <Field label={d.description} hint={d.descriptionHint}>
            <Textarea rows={2} value={meta.description} maxLength={1000} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={meta.enabled} onChange={(e) => setMeta({ ...meta, enabled: e.target.checked })} />
            {d.enabled}
          </label>
          <div className="flex gap-2">
            <Button
              disabled={pending || !meta.name.trim()}
              onClick={() =>
                start(async () => {
                  await saveTableMeta(clientId, row.id, meta);
                  setMode("view");
                })
              }
            >
              {d.save}
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              {d.cancel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

type Turn = { role: "user" | "assistant"; content: string; charts?: ChartSpec[]; error?: boolean };

function Analyst({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  const d = t.data;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const ask = (question: string) =>
    start(async () => {
      const history = turns.filter((x) => !x.error).map(({ role, content }) => ({ role, content }));
      setTurns((p) => [...p, { role: "user", content: question }]);
      setQ("");
      const r = await askDataAction(clientId, { question, history });
      setTurns((p) => [
        ...p,
        r.error ? { role: "assistant", content: (d.errors as Record<string, string>)[r.error] ?? d.errors.failed, error: true } : { role: "assistant", content: r.answer, charts: r.charts },
      ]);
    });
  return (
    <section className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="size-4 text-accent" />
          {d.analyst}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{d.analystHint}</p>
      </div>
      <Card className="space-y-3 p-4">
        {turns.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {d.examples.map((x) => (
              <button key={x} type="button" disabled={pending} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-surface-2" onClick={() => ask(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        {turns.map((x, i) => (
          <div key={i} className={cx("rounded-xl p-3 text-sm", x.role === "user" ? "ml-auto max-w-[80%] bg-accent/10" : "bg-surface-2/60", x.error && "text-danger")}>
            <p className="whitespace-pre-wrap">{x.content}</p>
            {x.charts?.map((c, j) => (
              <Chart key={j} spec={c} />
            ))}
          </div>
        ))}
        {pending && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> {d.thinking}
          </p>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim() && !pending) ask(q.trim());
          }}
        >
          <Input className="flex-1" value={q} maxLength={2000} placeholder={d.askPlaceholder} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" disabled={pending || !q.trim()}>
            <Send className="size-4" />
          </Button>
        </form>
      </Card>
    </section>
  );
}

const COLORS = ["var(--accent)", "#e8a23a", "#3aa889", "#c25b8a"];
const short = (n: number) => (Math.abs(n) >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${+(n / 1e3).toFixed(0)}k` : String(+n.toFixed(2)));

/** Простой график (столбцы или линия) из ответа «Аналитика»: одна ось, легенда при нескольких рядах. */
function Chart({ spec }: { spec: ChartSpec }) {
  const W = 640;
  const H = 260;
  const pad = { l: 48, r: 12, t: 12, b: 56 };
  const all = spec.series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const y = (v: number) => pad.t + ((max - v) / span) * (H - pad.t - pad.b);
  const n = spec.labels.length;
  const band = (W - pad.l - pad.r) / n;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => min + span * k);
  const every = Math.ceil(n / 12);
  return (
    <figure className="mt-3">
      <figcaption className="mb-1 text-xs font-semibold">{spec.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={spec.title}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
              {short(v)}
            </text>
          </g>
        ))}
        {spec.type === "bar"
          ? spec.series.map((s, si) => {
              const w = Math.max(2, (band - 6) / spec.series.length - 2);
              return s.values.map((v, i) => {
                const x = pad.l + i * band + 3 + si * (w + 2);
                const top = Math.min(y(v), y(0));
                return (
                  <rect key={`${si}-${i}`} x={x} y={top} width={w} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={Math.min(4, w / 2)} fill={COLORS[si]}>
                    <title>{`${spec.labels[i]} · ${s.name}: ${v}`}</title>
                  </rect>
                );
              });
            })
          : spec.series.map((s, si) => (
              <g key={si}>
                <polyline fill="none" stroke={COLORS[si]} strokeWidth={2} points={s.values.map((v, i) => `${pad.l + i * band + band / 2},${y(v)}`).join(" ")} />
                {s.values.map((v, i) => (
                  <circle key={i} cx={pad.l + i * band + band / 2} cy={y(v)} r={4} fill={COLORS[si]} stroke="var(--surface)" strokeWidth={2}>
                    <title>{`${spec.labels[i]} · ${s.name}: ${v}`}</title>
                  </circle>
                ))}
              </g>
            ))}
        {spec.labels.map((l, i) =>
          i % every === 0 ? (
            <text key={i} x={pad.l + i * band + band / 2} y={H - pad.b + 14} textAnchor="end" fontSize={10} fill="var(--muted)" transform={`rotate(-30 ${pad.l + i * band + band / 2} ${H - pad.b + 14})`}>
              {l.length > 16 ? `${l.slice(0, 15)}…` : l}
            </text>
          ) : null,
        )}
      </svg>
      {spec.series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-3 text-xs">
          {spec.series.map((s, si) => (
            <span key={si} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: COLORS[si] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}
