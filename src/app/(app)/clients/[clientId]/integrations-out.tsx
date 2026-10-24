"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, Plus, Send, Sheet, Trash2, Webhook } from "lucide-react";
import { deleteIntegration, saveIntegration, testIntegration } from "@/app/actions/client-integrations";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select, cx } from "@/components/ui";
import { INTEGRATION_EVENTS, type IntegrationEventType } from "@/lib/integrations/types";
import { ask } from "@/components/confirm-dialog";

export type IntegrationRow = {
  id: string;
  kind: "sheet" | "webhook";
  name: string;
  url: string;
  sheet: string;
  secret: string;
  events: IntegrationEventType[];
  enabled: boolean;
  lastStatus: string | null;
  lastAt: Date | null;
};

type Draft = Pick<IntegrationRow, "kind" | "name" | "url" | "sheet" | "events" | "enabled">;
const EMPTY: Draft = { kind: "sheet", name: "", url: "", sheet: "Лист1", events: ["lead", "handoff", "booking"], enabled: true };

/** Отправка данных клиента во внешние системы: Google Таблица или вебхук. */
export function IntegrationsOut({ clientId, rows, googleEmail }: { clientId: string; rows: IntegrationRow[]; googleEmail: string | null }) {
  const { t, locale } = useI18n();
  const o = t.tools.out;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="space-y-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold">{o.title}</div>
          <p className="mt-1 max-w-3xl text-sm text-muted">{o.hint}</p>
        </div>
        {editing !== "new" && (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            {o.add}
          </Button>
        )}
      </div>
      {editing === "new" && <OutForm clientId={clientId} initial={EMPTY} googleEmail={googleEmail} onDone={() => setEditing(null)} />}
      {rows.length === 0 && editing !== "new" && <p className="text-sm text-muted">{o.empty}</p>}
      {rows.map((r) =>
        editing === r.id ? (
          <OutForm key={r.id} clientId={clientId} id={r.id} initial={r} secret={r.secret} googleEmail={googleEmail} onDone={() => setEditing(null)} />
        ) : (
          <Card key={r.id} className="p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
                {r.kind === "sheet" ? <Sheet className="size-5" /> : <Webhook className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <Badge tone="neutral">{o.kinds[r.kind]}</Badge>
                  {!r.enabled && <Badge tone="warning">{t.status.paused}</Badge>}
                </div>
                <p className="mt-1 break-all font-mono text-xs text-muted">
                  {r.url}
                  {r.kind === "sheet" && ` · ${r.sheet}`}
                </p>
                <p className="mt-1 text-xs text-muted">{r.events.map((e) => o.eventNames[e].split(" (")[0]).join(" · ")}</p>
                <p className={cx("mt-1 text-xs", r.lastStatus?.startsWith("error") ? "text-danger" : "text-muted")}>
                  {o.last}: {r.lastAt ? `${fmt.format(r.lastAt)} · ${r.lastStatus ?? ""}` : o.never}
                </p>
              </div>
              <div className="flex gap-1">
                <TestButton id={r.id} />
                <Button variant="ghost" size="sm" onClick={() => setEditing(r.id)} title={t.tools.edit}>
                  <Pencil className="size-4" />
                </Button>
                <DeleteButton id={r.id} />
              </div>
            </div>
          </Card>
        ),
      )}
    </div>
  );
}

function TestButton({ id }: { id: string }) {
  const { t } = useI18n();
  const o = t.tools.out;
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; error?: string } | null>(null);
  const err = (code?: string) => (t.tools.errors as Record<string, string>)[code ?? ""] ?? code;
  return (
    <span className="flex items-center gap-2">
      {res && <span className={cx("text-xs", res.ok ? "text-success" : "text-danger")}>{res.ok ? (
            <span className="flex items-center gap-1">
              <Check className="size-4" />
              {o.testOk}
            </span>
          ) : (
            err(res.error)
          )}</span>}
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(async () => setRes(await testIntegration(id)))}>
        <Send className="size-4" />
        {o.test}
      </Button>
    </span>
  );
}

function DeleteButton({ id }: { id: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" disabled={pending} title={t.tools.delete} onClick={async () => await ask(t.tools.confirmDelete) && start(() => deleteIntegration(id))}>
      <Trash2 className="size-4" />
    </Button>
  );
}

function OutForm({
  clientId,
  id,
  initial,
  secret,
  googleEmail,
  onDone,
}: {
  clientId: string;
  id?: string;
  initial: Draft;
  secret?: string;
  googleEmail: string | null;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const o = t.tools.out;
  const [d, setD] = useState<Draft>({ kind: initial.kind, name: initial.name, url: initial.url, sheet: initial.sheet, events: initial.events, enabled: initial.enabled });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const toggle = (e: IntegrationEventType) => set("events", d.events.includes(e) ? d.events.filter((x) => x !== e) : [...d.events, e]);
  const submit = () =>
    start(async () => {
      const r = await saveIntegration(clientId, id ?? null, d);
      if (r.error) setError((t.tools.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });

  return (
    <Card className="space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.tools.kindLabel}>
          <Select value={d.kind} disabled={Boolean(id)} onChange={(e) => set("kind", e.target.value as Draft["kind"])}>
            <option value="sheet">{o.kinds.sheet}</option>
            <option value="webhook">{o.kinds.webhook}</option>
          </Select>
        </Field>
        <Field label={o.name}>
          <Input value={d.name} maxLength={100} placeholder={o.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
        </Field>
      </div>
      {d.kind === "sheet" ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <Field label={o.sheetUrl}>
            <Input value={d.url} placeholder="https://docs.google.com/spreadsheets/d/…" className="font-mono text-[13px]" onChange={(e) => set("url", e.target.value)} />
          </Field>
          <Field label={o.sheet}>
            <Input value={d.sheet} maxLength={100} onChange={(e) => set("sheet", e.target.value)} />
          </Field>
          <p className="text-xs text-muted sm:col-span-2">
            {googleEmail ? (
              <>
                {o.sheetShare} <code className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono">{googleEmail}</code>
              </>
            ) : (
              t.tools.sheetNoGoogle
            )}
          </p>
        </div>
      ) : (
        <>
          <Field label={o.webhookUrl}>
            <Input value={d.url} placeholder="https://hooks.example.com/genagent" className="font-mono text-[13px]" onChange={(e) => set("url", e.target.value)} />
          </Field>
          {secret && (
            <Field label={o.secret} hint={o.secretHint}>
              <code className="block select-all break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">{secret}</code>
            </Field>
          )}
        </>
      )}
      <Field label={o.events}>
        <div className="space-y-1.5">
          {INTEGRATION_EVENTS.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.events.includes(e)} onChange={() => toggle(e)} />
              {o.eventNames[e]}
            </label>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {o.enabled}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !d.name.trim() || !d.url.trim()} onClick={submit}>
          {t.tools.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t.tools.cancel}
        </Button>
      </div>
    </Card>
  );
}
