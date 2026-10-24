"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Eye, Megaphone, Pause, Pencil, Play, Plus, Rocket, Square, Trash2, Users, Workflow, X } from "lucide-react";
import {
  deleteCampaign,
  launchCampaign,
  previewMessage,
  previewSegment,
  saveCampaign,
  setSequenceEnabled,
  stopCampaign,
} from "@/app/actions/campaigns";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, cx } from "@/components/ui";
import type { CampaignOptions, CampaignSegment, CampaignStep } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";

type Kind = "broadcast" | "sequence";
type Trigger = "idle" | "handoff" | "booking" | "hot";
type Status = "draft" | "scheduled" | "sending" | "done" | "active" | "paused";
type Stats = { total: number; pending: number; sent: number; skipped: number; failed: number; replied: number; optOut: number };

export type CampaignRow = {
  id: string;
  kind: Kind;
  name: string;
  status: Status;
  enabled: boolean;
  segment: CampaignSegment;
  steps: CampaignStep[];
  trigger: Trigger | null;
  scheduleAt: number | null;
  options: CampaignOptions;
  stats: Stats;
};

type Draft = Omit<CampaignRow, "id" | "status" | "enabled" | "stats">;

const CHANNELS = ["telegram", "api", "email", "whatsapp", "instagram", "viber", "sms"] as const;
const TEMPS = ["hot", "warm", "cold"] as const;
const TRIGGERS: Trigger[] = ["idle", "handoff", "booking", "hot"];

const empty = (kind: Kind): Draft => ({
  kind,
  name: "",
  segment: {},
  steps: [{ delayHours: kind === "sequence" ? 24 : 0, mode: "text", text: "" }],
  trigger: kind === "sequence" ? "idle" : null,
  scheduleAt: null,
  options: { quietHours: true, optOutHint: true },
});

export function CampaignsManager({ clientId, rows, agents }: { clientId: string; rows: CampaignRow[]; agents: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const c = t.campaigns;
  const [editing, setEditing] = useState<string | Kind | null>(null);

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{c.subtitle}</p>
      {editing !== "broadcast" && editing !== "sequence" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing("broadcast")}>
            <Megaphone className="size-4" />
            {c.kinds.broadcast}
          </Button>
          <Button variant="secondary" onClick={() => setEditing("sequence")}>
            <Workflow className="size-4" />
            {c.kinds.sequence}
          </Button>
        </div>
      )}
      {(editing === "broadcast" || editing === "sequence") && (
        <CampaignForm clientId={clientId} agents={agents} initial={empty(editing)} onDone={() => setEditing(null)} />
      )}
      {rows.length === 0 && editing === null && <EmptyState icon={<Megaphone />} text={c.empty} action={<Button variant="secondary" onClick={() => setEditing("broadcast")}><Megaphone className="size-4" />{c.kinds.broadcast}</Button>} />}
      {rows.map((r) =>
        editing === r.id ? (
          <CampaignForm key={r.id} clientId={clientId} id={r.id} agents={agents} initial={r} onDone={() => setEditing(null)} />
        ) : (
          <CampaignCard key={r.id} clientId={clientId} row={r} onEdit={() => setEditing(r.id)} />
        ),
      )}
    </div>
  );
}

function CampaignCard({ clientId, row: r, onEdit }: { clientId: string; row: CampaignRow; onEdit: () => void }) {
  // Пауза и запуск цепочки — сразу на экране, сохранение в фоне
  const [enabled, setEnabled] = useOptimistic(r.enabled);
  const { t } = useI18n();
  const c = t.campaigns;
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const err = (code?: string) => (c.errors as Record<string, string>)[code ?? ""] ?? code ?? "";
  const stats = Object.entries(r.stats).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), c.stats);
  const editable = r.kind === "sequence" || r.status === "draft";
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
          {r.kind === "broadcast" ? <Megaphone className="size-5" /> : <Workflow className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{r.name}</span>
            <Badge tone="neutral">{c.kinds[r.kind]}</Badge>
            <Badge tone={r.status === "active" || r.status === "sending" ? "success" : r.status === "draft" || r.status === "paused" ? "warning" : "neutral"}>{c.status[r.status]}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted">
            {r.kind === "sequence" && r.trigger ? `${c.triggers[r.trigger]} · ` : ""}
            {c.steps}: {r.steps.length}
          </p>
          <p className="mt-1 text-xs text-muted">{stats}</p>
          {preview && (
            <div className="mt-2 rounded-lg bg-surface-2 p-2.5 text-sm">
              <div className="mb-1 flex items-center justify-between text-xs font-medium text-muted">
                {c.previewMsg}
                <button type="button" onClick={() => setPreview(null)} aria-label="×">
                  <X className="size-3.5" />
                </button>
              </div>
              <p className="whitespace-pre-wrap">{preview}</p>
            </div>
          )}
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            title={c.previewMsg}
            onClick={() =>
              start(async () => {
                setError(null);
                const p = await previewMessage(r.id);
                if (p.text) setPreview(p.text);
                else setError(err(p.error));
              })
            }
          >
            <Eye className="size-4" />
          </Button>
          {r.kind === "broadcast" && r.status === "draft" && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const who = await previewSegment(clientId, r.segment);
                  if (!who.count) return setError(err("empty"));
                  if (!await ask(c.confirmLaunch.replace("{n}", String(who.count)))) return;
                  const res = await launchCampaign(r.id);
                  if (!res.count) setError(err("empty"));
                })
              }
            >
              <Rocket className="size-4" />
              {c.launch}
            </Button>
          )}
          {r.kind === "sequence" && (
            <Button
              size="sm"
              variant={enabled ? "secondary" : "primary"}
              onClick={() =>
                start(async () => {
                  setEnabled(!enabled);
                  const res = await setSequenceEnabled(r.id, !enabled).catch(() => ({ error: "" }));
                  if (res.error !== undefined) toast(err(res.error) || t.shell.saveFailed, "error");
                })
              }
            >
              {enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
              {enabled ? c.disable : c.enable}
            </Button>
          )}
          {r.kind === "broadcast" && (r.status === "scheduled" || r.status === "sending") && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => void (await stopCampaign(r.id)))}>
              <Square className="size-4" />
              {c.stop}
            </Button>
          )}
          {editable && (
            <Button variant="ghost" size="sm" title={c.edit} onClick={onEdit}>
              <Pencil className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={pending} title={c.delete} onClick={async () => await ask(c.confirmDelete) && start(() => deleteCampaign(r.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

const toLocalInput = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function CampaignForm({
  clientId,
  id,
  agents,
  initial,
  onDone,
}: {
  clientId: string;
  id?: string;
  agents: { id: string; name: string }[];
  initial: Draft;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const c = t.campaigns;
  const [d, setD] = useState<Draft>({ kind: initial.kind, name: initial.name, segment: initial.segment, steps: initial.steps, trigger: initial.trigger, scheduleAt: initial.scheduleAt, options: initial.options });
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<{ count: number; sample: string[] } | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const seg = (patch: Partial<CampaignSegment>) => {
    setWho(null);
    set("segment", { ...d.segment, ...patch });
  };
  const toggle = <T extends string>(list: T[] | undefined, v: T) => {
    const cur = list ?? [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    return next.length ? next : undefined;
  };
  const setStep = (i: number, p: Partial<CampaignStep>) => set("steps", d.steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const num = (v: string) => (v.trim() ? Math.max(1, Math.round(Number(v))) || undefined : undefined);
  const seq = d.kind === "sequence";

  const submit = () =>
    start(async () => {
      const r = await saveCampaign(clientId, id ?? null, d);
      if (r.error) setError((c.errors as Record<string, string>)[r.error] ?? r.error);
      else onDone();
    });

  return (
    <Card className="space-y-5 p-5">
      <div>
        <div className="flex items-center gap-2 font-semibold">
          {seq ? <Workflow className="size-4 text-accent" /> : <Megaphone className="size-4 text-accent" />}
          {c.kinds[d.kind]}
        </div>
        <p className="text-xs text-muted">{c.kindHints[d.kind]}</p>
      </div>
      <Field label={c.name}>
        <Input value={d.name} maxLength={100} placeholder={c.namePlaceholder} onChange={(e) => set("name", e.target.value)} />
      </Field>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4 text-accent" />
          {c.segment}
        </div>
        {agents.length > 1 && (
          <Field label={c.agents} hint={!d.segment.agentIds?.length ? c.allAgents : undefined}>
            <div className="flex flex-wrap gap-3">
              {agents.map((a) => (
                <label key={a.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.segment.agentIds?.includes(a.id) ?? false} onChange={() => seg({ agentIds: toggle(d.segment.agentIds, a.id) })} />
                  {a.name}
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label={c.channels}>
          <div className="flex flex-wrap gap-3">
            {CHANNELS.map((ch) => (
              <label key={ch} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.segment.channelTypes?.includes(ch) ?? false} onChange={() => seg({ channelTypes: toggle(d.segment.channelTypes, ch) })} />
                {c.channelNames[ch]}
              </label>
            ))}
          </div>
        </Field>
        <Field label={c.temperature}>
          <div className="flex flex-wrap gap-3">
            {TEMPS.map((x) => (
              <label key={x} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.segment.temperature?.includes(x) ?? false} onChange={() => seg({ temperature: toggle(d.segment.temperature, x) })} />
                {c.temps[x]}
              </label>
            ))}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={c.contains}>
            <Input value={d.segment.contains ?? ""} maxLength={100} placeholder={c.containsPlaceholder} onChange={(e) => seg({ contains: e.target.value || undefined })} />
          </Field>
          <Field label={c.activeWithin}>
            <Input type="number" min={1} value={d.segment.activeWithinDays ?? ""} onChange={(e) => seg({ activeWithinDays: num(e.target.value) })} />
          </Field>
          <Field label={c.inactiveFor}>
            <Input type="number" min={1} value={d.segment.inactiveForDays ?? ""} onChange={(e) => seg({ inactiveForDays: num(e.target.value) })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={Boolean(d.segment.hadHandoff)} onChange={(e) => seg({ hadHandoff: e.target.checked || undefined })} />
          {c.hadHandoff}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => start(async () => setWho(await previewSegment(clientId, d.segment)))}>
            <Eye className="size-4" />
            {c.preview}
          </Button>
          {who && (
            <span className="text-sm">
              {who.count ? c.previewCount.replace("{n}", String(who.count)) : c.previewNone}
              {who.sample.length > 0 && <span className="text-muted"> — {who.sample.join(", ")}{who.count > who.sample.length ? "…" : ""}</span>}
            </span>
          )}
        </div>
      </div>

      {seq ? (
        <Field label={c.trigger}>
          <Select value={d.trigger ?? "idle"} onChange={(e) => set("trigger", e.target.value as Trigger)}>
            {TRIGGERS.map((x) => (
              <option key={x} value={x}>
                {c.triggers[x]}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label={c.schedule} hint={c.scheduleHint}>
          <Input type="datetime-local" className="max-w-xs" value={toLocalInput(d.scheduleAt)} onChange={(e) => set("scheduleAt", e.target.value ? new Date(e.target.value).getTime() : null)} />
        </Field>
      )}

      <div className="space-y-3">
        <div className="text-sm font-semibold">{c.steps}</div>
        {d.steps.map((s, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-end gap-3">
              <span className="text-sm font-medium">{c.step.replace("{n}", String(i + 1))}</span>
              {seq && (
                <Field label={i === 0 ? c.delayFirst : c.delay}>
                  <Input type="number" min={0} className="w-28" value={s.delayHours} onChange={(e) => setStep(i, { delayHours: Math.max(0, Number(e.target.value) || 0) })} />
                </Field>
              )}
              <Field label={c.mode}>
                <Select value={s.mode} onChange={(e) => setStep(i, { mode: e.target.value as CampaignStep["mode"] })}>
                  <option value="text">{c.modes.text}</option>
                  <option value="ai">{c.modes.ai}</option>
                </Select>
              </Field>
              {d.steps.length > 1 && (
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => set("steps", d.steps.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              )}
            </div>
            <Textarea rows={3} maxLength={2000} value={s.text} placeholder={s.mode === "ai" ? c.aiPlaceholder : c.textPlaceholder} onChange={(e) => setStep(i, { text: e.target.value })} />
            <p className="text-xs text-muted">{s.mode === "ai" ? c.aiHint : c.textHint}</p>
          </div>
        ))}
        {seq && d.steps.length < 10 && (
          <Button variant="secondary" size="sm" onClick={() => set("steps", [...d.steps, { delayHours: 24, mode: "text", text: "" }])}>
            <Plus className="size-4" />
            {c.addStep}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.options.quietHours} onChange={(e) => set("options", { ...d.options, quietHours: e.target.checked })} />
          {c.quietHours}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.options.optOutHint} onChange={(e) => set("options", { ...d.options, optOutHint: e.target.checked })} />
          {c.optOutHint}
        </label>
      </div>
      {error && <p className={cx("text-sm text-danger")}>{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending || !d.name.trim()} onClick={submit}>
          {c.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {c.cancel}
        </Button>
      </div>
    </Card>
  );
}
