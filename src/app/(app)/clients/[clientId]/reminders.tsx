"use client";

import { useState, useTransition } from "react";
import { BellRing, Eye, History, ListPlus, Pencil, Play, Plus, Repeat, Trash2 } from "lucide-react";
import { deleteReminder, previewReminder, reminderLogAction, repeatToContacts, runReminderNow, runRepeatNow, saveReminder, saveRepeat } from "@/app/actions/reminders";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea, cx } from "@/components/ui";
import { ask } from "@/components/confirm-dialog";

export type TableOpt = { id: string; name: string; columns: string[] };
export type ChannelOpt = { id: string; name: string };
export type ReminderRow = {
  id: string;
  name: string;
  tableId: string;
  kind: "date" | "status";
  dateColumn: string;
  offsetDays: number;
  keyColumn: string;
  statusColumn: string;
  statusValues: string[];
  contactColumn: string;
  channelId: string | null;
  message: string;
  hour: number;
  notifyTeam: boolean;
  enabled: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
};
type Draft = Omit<ReminderRow, "id" | "lastRunAt" | "lastResult">;

/** Подобрать столбец по названию (дата оплаты, контакт, статус…) */
const guess = (cols: string[], re: RegExp) => cols.find((c) => re.test(c)) ?? "";

function emptyDraft(tables: TableOpt[], channels: ChannelOpt[]): Draft {
  const cols = tables[0]?.columns ?? [];
  return {
    name: "",
    tableId: tables[0]?.id ?? "",
    kind: "date",
    dateColumn: guess(cols, /дат|срок|date|due|оплат/i),
    offsetDays: 1,
    keyColumn: guess(cols, /№|номер|заказ|счёт|счет|id|order|invoice/i),
    statusColumn: guess(cols, /статус|status|состояни/i),
    statusValues: [],
    contactColumn: guess(cols, /контакт|telegram|телеграм|телефон|phone|e-?mail|почта|ник/i),
    channelId: channels[0]?.id ?? null,
    message: "",
    hour: 10,
    notifyTeam: true,
    enabled: true,
  };
}

export function RemindersManager({ clientId, rows, tables, channels }: { clientId: string; rows: ReminderRow[]; tables: TableOpt[]; channels: ChannelOpt[] }) {
  const { t, locale } = useI18n();
  const r = t.reminders;
  const [editing, setEditing] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{r.subtitle}</p>
      {tables.length === 0 ? (
        <EmptyState icon={<BellRing />} text={r.noTables} />
      ) : (
        <>
          {editing !== "new" && (
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              {r.new}
            </Button>
          )}
          {editing === "new" && <ReminderForm clientId={clientId} tables={tables} channels={channels} initial={emptyDraft(tables, channels)} onDone={() => setEditing(null)} />}
          {rows.length === 0 && editing !== "new" && <EmptyState icon={<BellRing />} text={r.empty} />}
          {rows.map((x) =>
            editing === x.id ? (
              <ReminderForm key={x.id} clientId={clientId} tables={tables} channels={channels} id={x.id} initial={x} onDone={() => setEditing(null)} />
            ) : (
              <ReminderCard key={x.id} row={x} table={tables.find((tb) => tb.id === x.tableId)?.name ?? "—"} last={x.lastRunAt ? fmt.format(x.lastRunAt) : null} onEdit={() => setEditing(x.id)} />
            ),
          )}
        </>
      )}
    </div>
  );
}

function ReminderCard({ row, table, last, onEdit }: { row: ReminderRow; table: string; last: string | null; onEdit: () => void }) {
  const { t, locale } = useI18n();
  const r = t.reminders;
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [log, setLog] = useState<Awaited<ReturnType<typeof reminderLogAction>> | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });
  const when =
    row.kind === "date"
      ? `${row.offsetDays > 0 ? r.before.replace("{n}", String(row.offsetDays)) : row.offsetDays === 0 ? r.onDay : r.after.replace("{n}", String(-row.offsetDays))} «${row.dateColumn}», ${String(row.hour).padStart(2, "0")}:00`
      : `${r.onStatus} «${row.statusColumn}»${row.statusValues.length ? `: ${row.statusValues.join(", ")}` : ""}`;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
          <BellRing className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.name}</span>
            <Badge tone={row.enabled ? "success" : "warning"}>{row.enabled ? r.kinds[row.kind] : t.status.paused}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            {table} · {when}
          </p>
          <p className="mt-1 line-clamp-2 text-sm">{row.message}</p>
          {last && (
            <p className={cx("mt-1 text-xs", row.lastResult?.startsWith("error") ? "text-danger" : "text-muted")}>
              {r.last}: {last} · {row.lastResult}
            </p>
          )}
          {msg && <p className="mt-1 text-sm text-muted">{msg}</p>}
          {log && (
            <div className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2/60 p-2 text-xs">
              {log.length === 0 && <p className="text-muted">{r.logEmpty}</p>}
              {log.map((x, i) => (
                <div key={i} className="flex gap-2 py-0.5">
                  <span className="text-muted">{fmt.format(x.createdAt)}</span>
                  <span className="font-medium">{x.rowKey}</span>
                  <span>{x.value}</span>
                  <span className="text-muted">{x.contact}</span>
                  <span className={x.status === "sent" ? "text-success" : "text-danger"}>{(r.statuses as Record<string, string>)[x.status] ?? x.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={async () =>
              await ask(r.confirmRun) &&
              start(async () => {
                const res = await runReminderNow(row.id);
                setMsg("error" in res ? r.errors.failed : res.baseline != null ? r.baseline.replace("{n}", String(res.baseline)) : r.ran.replace("{sent}", String(res.sent)).replace("{none}", String(res.noChat.length)))
              })
            }
          >
            {pending ? <Spinner /> : <Play className="size-4" />}
            {r.runNow}
          </Button>
          <Button variant="ghost" size="sm" title={r.log} disabled={pending} onClick={() => (log ? setLog(null) : start(async () => setLog(await reminderLogAction(row.id))))}>
            <History className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" title={r.edit} onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} title={r.delete} onClick={async () => await ask(r.confirmDelete) && start(() => deleteReminder(row.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ColumnSelect({ cols, value, onChange, optional }: { cols: string[]; value: string; onChange: (v: string) => void; optional?: boolean }) {
  const { t } = useI18n();
  return (
    <Select className="w-56" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{optional ? t.reminders.none : t.reminders.choose}</option>
      {cols.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </Select>
  );
}

function ReminderForm({ clientId, tables, channels, id, initial, onDone }: { clientId: string; tables: TableOpt[]; channels: ChannelOpt[]; id?: string; initial: Draft; onDone: () => void }) {
  const { t } = useI18n();
  const r = t.reminders;
  const [d, setD] = useState<Draft>({ ...initial });
  const [values, setValues] = useState(initial.statusValues.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; contact: string; text: string }[] | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const cols = tables.find((x) => x.id === d.tableId)?.columns ?? [];
  const payload = () => ({ ...d, statusValues: values.split(",").map((x) => x.trim()).filter(Boolean) });
  const submit = () =>
    start(async () => {
      const res = await saveReminder(clientId, id ?? null, payload());
      if (res.error) setError((r.errors as Record<string, string>)[res.error] ?? res.error);
      else onDone();
    });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap gap-3">
        <Field label={r.name}>
          <Input className="w-72" value={d.name} maxLength={100} placeholder={r.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label={r.table}>
          <Select className="w-64" value={d.tableId} onChange={(e) => set("tableId", e.target.value)}>
            {tables.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={r.kind}>
          <Select className="w-64" value={d.kind} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
            <option value="date">{r.kinds.date}</option>
            <option value="status">{r.kinds.status}</option>
          </Select>
        </Field>
      </div>
      <p className="text-xs text-muted">{r.kindHint[d.kind]}</p>
      <div className="flex flex-wrap gap-3">
        <Field label={r.contactColumn} hint={r.contactHint}>
          <ColumnSelect cols={cols} value={d.contactColumn} onChange={(v) => set("contactColumn", v)} />
        </Field>
        {d.kind === "date" ? (
          <>
            <Field label={r.dateColumn}>
              <ColumnSelect cols={cols} value={d.dateColumn} onChange={(v) => set("dateColumn", v)} />
            </Field>
            <Field label={r.offset} hint={r.offsetHint}>
              <Input type="number" min={-60} max={365} className="w-28" value={d.offsetDays} onChange={(e) => set("offsetDays", Math.round(Number(e.target.value) || 0))} />
            </Field>
            <Field label={r.hour}>
              <Select className="w-28" value={d.hour} onChange={(e) => set("hour", Number(e.target.value))}>
                {Array.from({ length: 14 }, (_, i) => i + 8).map((h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={r.keyColumn} hint={r.keyHint}>
              <ColumnSelect cols={cols} value={d.keyColumn} onChange={(v) => set("keyColumn", v)} optional />
            </Field>
          </>
        ) : (
          <Field label={r.keyColumn} hint={r.keyHintStatus}>
            <ColumnSelect cols={cols} value={d.keyColumn} onChange={(v) => set("keyColumn", v)} />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={r.statusColumn}>
          <ColumnSelect cols={cols} value={d.statusColumn} onChange={(v) => set("statusColumn", v)} optional={d.kind === "date"} />
        </Field>
        <Field label={d.kind === "date" ? r.statusFilter : r.statusNotify} hint={d.kind === "date" ? r.statusFilterHint : r.statusNotifyHint}>
          <Input className="w-96" value={values} maxLength={1000} placeholder={d.kind === "date" ? r.statusFilterPlaceholder : r.statusNotifyPlaceholder} onChange={(e) => setValues(e.target.value)} />
        </Field>
      </div>
      <Field label={r.message} hint={r.messageHint}>
        <Textarea rows={3} value={d.message} maxLength={3000} placeholder={r.messagePlaceholder} onChange={(e) => set("message", e.target.value)} />
      </Field>
      {cols.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cols.map((c) => (
            <button key={c} type="button" className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs hover:text-accent" onClick={() => set("message", `${d.message}{{${c}}}`)}>
              {`{{${c}}}`}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Field label={r.mailChannel} hint={r.mailChannelHint}>
          <Select className="w-64" value={d.channelId ?? ""} onChange={(e) => set("channelId", e.target.value || null)}>
            <option value="">{r.noMail}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.notifyTeam} onChange={(e) => set("notifyTeam", e.target.checked)} />
          {r.notifyTeam}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {r.enabled}
        </label>
      </div>
      {preview && (
        <div className="rounded-lg bg-surface-2/60 p-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-muted">{r.previewTitle}</div>
          {preview.length === 0 && <p className="text-muted">{r.previewEmpty}</p>}
          {preview.map((x, i) => (
            <p key={i}>
              <b>{x.contact}</b>: {x.text}
            </p>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !d.name.trim() || !d.message.trim()} onClick={submit}>
          {r.save}
        </Button>
        {d.kind === "date" && (
          <Button variant="secondary" disabled={pending} onClick={() => start(async () => setPreview(await previewReminder(clientId, payload())))}>
            <Eye className="size-4" />
            {r.preview}
          </Button>
        )}
        <Button variant="ghost" onClick={onDone}>
          {r.cancel}
        </Button>
      </div>
    </Card>
  );
}

// ---------- повторные покупки ----------

export type RepeatConfig = {
  tableId: string;
  customerColumn: string;
  dateColumn: string;
  contactColumn: string;
  productColumn: string;
  amountColumn: string;
  leadDays: number;
  minOrders: number;
  auto: boolean;
  brief: string;
  channelId: string | null;
  hour: number;
  lastRunAt: number | null;
  lastResult: string | null;
};
export type RepeatRow = {
  customer: string;
  contact: string;
  orders: number;
  lastDate: string;
  interval: number;
  nextDate: string;
  daysLeft: number;
  probability: number;
  status: "due" | "late" | "lost" | "later";
  total: number | null;
  products: string[];
};

export function RepeatManager({ clientId, config, list, tables, channels }: { clientId: string; config: RepeatConfig | null; list: RepeatRow[]; tables: TableOpt[]; channels: ChannelOpt[] }) {
  const { t } = useI18n();
  const r = t.repeat;
  const cols0 = tables[0]?.columns ?? [];
  const [d, setD] = useState<RepeatConfig>(
    config ?? {
      tableId: tables[0]?.id ?? "",
      customerColumn: guess(cols0, /клиент|покупател|имя|name|customer/i),
      dateColumn: guess(cols0, /дат|date/i),
      contactColumn: guess(cols0, /контакт|telegram|телефон|phone|e-?mail|почта/i),
      productColumn: guess(cols0, /товар|продукт|product|услуг|позици/i),
      amountColumn: guess(cols0, /сумм|amount|total|итого/i),
      leadDays: 3,
      minOrders: 2,
      auto: false,
      brief: "",
      channelId: channels[0]?.id ?? null,
      hour: 11,
      lastRunAt: null,
      lastResult: null,
    },
  );
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof RepeatConfig>(k: K, v: RepeatConfig[K]) => setD({ ...d, [k]: v });
  const cols = tables.find((x) => x.id === d.tableId)?.columns ?? [];
  const shown = filter === "all" ? list : list.filter((x) => x.status === "due" || x.status === "late");
  const tone = (s: RepeatRow["status"]) => (s === "due" ? "success" : s === "late" ? "warning" : s === "lost" ? "neutral" : "accent") as "success" | "warning" | "neutral" | "accent";
  if (!tables.length) return <EmptyState icon={<Repeat />} text={r.noTables} />;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{r.subtitle}</p>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap gap-3">
          <Field label={r.table}>
            <Select className="w-64" value={d.tableId} onChange={(e) => set("tableId", e.target.value)}>
              {tables.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          {(["customerColumn", "dateColumn", "contactColumn", "productColumn", "amountColumn"] as const).map((k) => (
            <Field key={k} label={r.columns[k]}>
              <ColumnSelect cols={cols} value={d[k]} onChange={(v) => set(k, v)} optional={k !== "customerColumn" && k !== "dateColumn"} />
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label={r.leadDays} hint={r.leadDaysHint}>
            <Input type="number" min={0} max={60} className="w-24" value={d.leadDays} onChange={(e) => set("leadDays", Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          </Field>
          <Field label={r.minOrders}>
            <Input type="number" min={2} max={50} className="w-24" value={d.minOrders} onChange={(e) => set("minOrders", Math.max(2, Math.round(Number(e.target.value) || 2)))} />
          </Field>
        </div>
        <Field label={r.brief} hint={r.briefHint}>
          <Textarea rows={2} value={d.brief} maxLength={1000} placeholder={r.briefPlaceholder} onChange={(e) => set("brief", e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.auto} onChange={(e) => set("auto", e.target.checked)} />
            {r.auto}
          </label>
          <Select className="w-28" title={r.hour} value={d.hour} onChange={(e) => set("hour", Number(e.target.value))}>
            {Array.from({ length: 14 }, (_, i) => i + 8).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
          <Select className="w-64" title={t.reminders.mailChannel} value={d.channelId ?? ""} onChange={(e) => set("channelId", e.target.value || null)}>
            <option value="">{t.reminders.noMail}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        {config?.lastRunAt && (
          <p className="text-xs text-muted">
            {r.last}: {new Date(config.lastRunAt).toLocaleString()} · {config.lastResult}
          </p>
        )}
        {msg && <p className={msg.ok ? "text-sm text-success" : "text-sm text-danger"}>{msg.text}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await saveRepeat(clientId, d);
                setMsg(res.error ? { ok: false, text: (r.errors as Record<string, string>)[res.error] ?? res.error } : { ok: true, text: r.saved });
              })
            }
          >
            {r.save}
          </Button>
          {config && (
            <>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={async () =>
                  await ask(r.confirmRun) &&
                  start(async () => {
                    const res = await runRepeatNow(clientId);
                    setMsg({ ok: true, text: r.ran.replace("{sent}", String(res.sent)).replace("{none}", String(res.noChat.length)) });
                  })
                }
              >
                <Play className="size-4" />
                {r.runNow}
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await repeatToContacts(clientId);
                    setMsg(res.error ? { ok: false, text: (r.errors as Record<string, string>)[res.error] ?? res.error } : { ok: true, text: r.listCreated.replace("{n}", String(res.count)) });
                  })
                }
              >
                <ListPlus className="size-4" />
                {r.toList}
              </Button>
            </>
          )}
        </div>
      </Card>
      {config && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">
              {r.forecast} · {shown.length}
            </h2>
            <Select className="w-72" value={filter} onChange={(e) => setFilter(e.target.value as "active" | "all")}>
              <option value="active">{r.filterActive}</option>
              <option value="all">{r.filterAll}</option>
            </Select>
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-muted">{r.empty}</p>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2">{r.th.customer}</th>
                    <th className="px-3 py-2">{r.th.status}</th>
                    <th className="px-3 py-2">{r.th.next}</th>
                    <th className="px-3 py-2">{r.th.probability}</th>
                    <th className="px-3 py-2">{r.th.history}</th>
                    <th className="px-3 py-2">{r.th.products}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 300).map((x) => (
                    <tr key={x.customer} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{x.customer}</div>
                        <div className="text-xs text-muted">{x.contact || "—"}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={tone(x.status)}>{r.statuses[x.status]}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {x.nextDate}
                        <div className="text-xs text-muted">{x.daysLeft >= 0 ? r.inDays.replace("{n}", String(x.daysLeft)) : r.lateDays.replace("{n}", String(-x.daysLeft))}</div>
                      </td>
                      <td className="px-3 py-2 font-semibold">{x.probability}%</td>
                      <td className="px-3 py-2 text-xs text-muted">
                        {r.history.replace("{orders}", String(x.orders)).replace("{interval}", String(x.interval)).replace("{last}", x.lastDate)}
                        {x.total != null && ` · ${x.total}`}
                      </td>
                      <td className="px-3 py-2 text-xs">{x.products.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
