"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, GraduationCap, Mail, Pencil, Plus, RefreshCw, Trash2, Upload, UserPlus, Users, X } from "lucide-react";
import { deleteOnboarding, deletePlan, resendOnboardingWelcome, savePlan, startOnboarding, toggleOnboardingItem } from "@/app/actions/onboarding";
import { addResumeText, deleteCandidate, deleteVacancy, rescoreVacancy, saveVacancy } from "@/app/actions/hiring";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea, cx } from "@/components/ui";
import type { OnboardingItem, OnboardingStep } from "@/db/schema";
import { ask } from "@/components/confirm-dialog";

export type PlanRow = { id: string; name: string; steps: OnboardingStep[]; welcome: string };
export type OnboardingRow = {
  id: string;
  name: string;
  role: string;
  contact: string;
  email: string;
  startDate: string;
  items: OnboardingItem[];
  welcomeStatus: string;
  welcomeText: string;
  status: "active" | "done";
};
type ChannelOpt = { id: string; name: string };

const today = () => new Date().toISOString().slice(0, 10);

export function OnboardingManager({ clientId, plans, rows, channels, teamAgent }: { clientId: string; plans: PlanRow[]; rows: OnboardingRow[]; channels: ChannelOpt[]; teamAgent: boolean }) {
  const { t } = useI18n();
  const o = t.onboarding;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">{o.subtitle}</p>
      {!teamAgent && <p className="max-w-3xl rounded-lg bg-amber-500/10 p-3 text-sm">{o.noTeamAgent}</p>}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ClipboardCheck className="size-4 text-accent" />
          {o.plans}
        </h2>
        {editing !== "new" && (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            {o.newPlan}
          </Button>
        )}
        {editing === "new" && <PlanForm clientId={clientId} initial={{
              name: "",
              steps: [
                { title: o.example.meet, day: 0, kind: "meet", owner: o.example.lead },
                { title: o.example.access, day: 0, kind: "task", owner: "" },
                { title: o.example.read, day: 1, kind: "read", owner: "" },
                { title: o.example.task, day: 5, kind: "task", owner: o.example.lead },
              ],
              welcome: "",
            }} onDone={() => setEditing(null)} />}
        {plans.map((p) =>
          editing === p.id ? (
            <PlanForm key={p.id} clientId={clientId} id={p.id} initial={p} onDone={() => setEditing(null)} />
          ) : (
            <Card key={p.id} className="flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{p.name}</div>
                <p className="mt-1 text-xs text-muted">{p.steps.map((s) => `${o.dayShort.replace("{n}", String(s.day))} ${s.title}`).join(" · ")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditing(p.id)}>
                <Pencil className="size-4" />
              </Button>
              <DeleteBtn text={o.confirmDeletePlan} run={() => deletePlan(p.id)} />
            </Card>
          ),
        )}
      </section>
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <GraduationCap className="size-4 text-accent" />
          {o.people}
        </h2>
        {!adding && (
          <Button onClick={() => setAdding(true)}>
            <UserPlus className="size-4" />
            {o.newPerson}
          </Button>
        )}
        {adding && <NewPerson clientId={clientId} plans={plans} channels={channels} onDone={() => setAdding(false)} />}
        {rows.length === 0 && !adding && <EmptyState icon={<GraduationCap />} text={o.empty} />}
        {rows.map((r) => (
          <PersonCard key={r.id} row={r} />
        ))}
      </section>
    </div>
  );
}

function DeleteBtn({ text, run }: { text: string; run: () => Promise<unknown> }) {
  const [pending, start] = useTransition();
  return (
    <Button variant="ghost" size="sm" disabled={pending} onClick={async () => await ask(text) && start(async () => void (await run()))}>
      <Trash2 className="size-4" />
    </Button>
  );
}

function PlanForm({ clientId, id, initial, onDone }: { clientId: string; id?: string; initial: Omit<PlanRow, "id">; onDone: () => void }) {
  const { t } = useI18n();
  const o = t.onboarding;
  const [d, setD] = useState({ ...initial, steps: initial.steps.map((s) => ({ ...s })) });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const setStep = (i: number, p: Partial<OnboardingStep>) => setD({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  return (
    <Card className="space-y-3 p-5">
      <Field label={o.planName}>
        <Input className="w-80" value={d.name} maxLength={100} placeholder={o.planNamePlaceholder} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <div className="text-sm font-semibold">{o.steps}</div>
        {d.steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input type="number" min={0} max={90} className="w-20" title={o.day} value={s.day} onChange={(e) => setStep(i, { day: Math.min(90, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
            <Select className="w-40" value={s.kind} onChange={(e) => setStep(i, { kind: e.target.value as OnboardingStep["kind"] })}>
              {(["task", "meet", "read"] as const).map((k) => (
                <option key={k} value={k}>
                  {o.kinds[k]}
                </option>
              ))}
            </Select>
            <Input className="min-w-64 flex-1" value={s.title} maxLength={200} placeholder={o.stepTitle} onChange={(e) => setStep(i, { title: e.target.value })} />
            <Input className="w-56" value={s.owner} maxLength={100} placeholder={o.owner} onChange={(e) => setStep(i, { owner: e.target.value })} />
            <Button variant="ghost" size="sm" onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" onClick={() => setD({ ...d, steps: [...d.steps, { title: "", day: d.steps.at(-1)?.day ?? 0, kind: "task", owner: "" }] })}>
          <Plus className="size-4" />
          {o.addStep}
        </Button>
        <p className="text-xs text-muted">{o.stepsHint}</p>
      </div>
      <Field label={o.welcome} hint={o.welcomeHint}>
        <Textarea rows={2} value={d.welcome} maxLength={2000} placeholder={o.welcomePlaceholder} onChange={(e) => setD({ ...d, welcome: e.target.value })} />
      </Field>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.name.trim()}
          onClick={() =>
            start(async () => {
              const r = await savePlan(clientId, id ?? null, { ...d, steps: d.steps.filter((s) => s.title.trim()) });
              if (r.error) setError(o.errors.invalid);
              else onDone();
            })
          }
        >
          {o.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {o.cancel}
        </Button>
      </div>
    </Card>
  );
}

function NewPerson({ clientId, plans, channels, onDone }: { clientId: string; plans: PlanRow[]; channels: ChannelOpt[]; onDone: () => void }) {
  const { t } = useI18n();
  const o = t.onboarding;
  const [d, setD] = useState<{ planId: string | null; name: string; role: string; contact: string; email: string; channelId: string | null; startDate: string; notes: string; personalize: boolean }>({ planId: plans[0]?.id ?? null, name: "", role: "", contact: "", email: "", channelId: channels[0]?.id ?? null, startDate: today(), notes: "", personalize: true });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap gap-3">
        <Field label={o.name}>
          <Input className="w-56" value={d.name} maxLength={100} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label={o.role}>
          <Input className="w-56" value={d.role} maxLength={100} placeholder={o.rolePlaceholder} onChange={(e) => setD({ ...d, role: e.target.value })} />
        </Field>
        <Field label={o.startDate}>
          <Input type="date" className="w-44" value={d.startDate} onChange={(e) => setD({ ...d, startDate: e.target.value })} />
        </Field>
        <Field label={o.plan}>
          <Select className="w-56" value={d.planId ?? ""} onChange={(e) => setD({ ...d, planId: e.target.value || null })}>
            <option value="">{o.noPlan}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={o.contact} hint={o.contactHint}>
          <Input className="w-56" value={d.contact} maxLength={100} placeholder="@maria" onChange={(e) => setD({ ...d, contact: e.target.value })} />
        </Field>
        <Field label={o.email}>
          <Input className="w-64" value={d.email} maxLength={200} placeholder="maria@company.com" onChange={(e) => setD({ ...d, email: e.target.value })} />
        </Field>
        {channels.length > 0 && (
          <Field label={o.mailFrom}>
            <Select className="w-56" value={d.channelId ?? ""} onChange={(e) => setD({ ...d, channelId: e.target.value || null })}>
              <option value="">—</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <Field label={o.notes} hint={o.notesHint}>
        <Textarea rows={2} value={d.notes} maxLength={2000} onChange={(e) => setD({ ...d, notes: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.personalize} onChange={(e) => setD({ ...d, personalize: e.target.checked })} />
        {o.personalize}
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.name.trim()}
          onClick={() =>
            start(async () => {
              const r = await startOnboarding(clientId, d);
              if (r.error) return setError((o.errors as Record<string, string>)[r.error] ?? r.error);
              if (r.welcome !== "sent") alert(o.welcomeNotSent);
              onDone();
            })
          }
        >
          {pending ? <Spinner /> : <UserPlus className="size-4" />}
          {o.start}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {o.cancel}
        </Button>
      </div>
    </Card>
  );
}

function PersonCard({ row }: { row: OnboardingRow }) {
  const { t } = useI18n();
  const o = t.onboarding;
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(row.status === "active");
  const done = row.items.filter((i) => i.done).length;
  const now = today();
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.name}</span>
            {row.role && <span className="text-sm text-muted">{row.role}</span>}
            <Badge tone={row.status === "done" ? "success" : "accent"}>{row.status === "done" ? o.finished : `${done}/${row.items.length}`}</Badge>
            {row.welcomeStatus !== "sent" && <Badge tone="warning">{o.welcomeMissing}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted">
            {o.startShort} {row.startDate} · {[row.contact, row.email].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-accent" style={{ width: `${row.items.length ? Math.round((done / row.items.length) * 100) : 0}%` }} />
          </div>
          <button type="button" className="mt-2 text-xs font-medium text-accent hover:underline" onClick={() => setOpen(!open)}>
            {open ? o.hide : o.show}
          </button>
        </div>
        <Button variant="ghost" size="sm" title={o.resend} disabled={pending} onClick={() => start(async () => void alert((await resendOnboardingWelcome(row.id)) === "sent" ? o.resent : o.welcomeNotSent))}>
          <Mail className="size-4" />
        </Button>
        <DeleteBtn text={o.confirmDelete} run={() => deleteOnboarding(row.id)} />
      </div>
      {open && (
        <ul className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
          {row.items.map((i) => (
            <li key={i.id} className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={i.done} disabled={pending} onChange={(e) => start(() => toggleOnboardingItem(row.id, i.id, e.target.checked))} />
              <span className={cx("min-w-0 flex-1", i.done && "text-muted line-through")}>
                {i.title}
                {i.owner && <span className="text-muted"> — {i.owner}</span>}
              </span>
              <span className={cx("shrink-0 text-xs", !i.done && i.due < now ? "text-danger" : "text-muted")}>
                {o.kinds[i.kind]} · {i.due}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------- подбор ----------

export type VacancyRow = { id: string; title: string; requirements: string; candidates: CandidateRow[] };
export type CandidateRow = {
  id: string;
  name: string;
  contact: string;
  filename: string;
  score: number | null;
  verdict: "strong" | "maybe" | "no" | null;
  summary: string;
  strengths: string[];
  gaps: string[];
  status: "processing" | "done" | "error";
  error: string | null;
};

export function HiringManager({ clientId, rows }: { clientId: string; rows: VacancyRow[] }) {
  const { t } = useI18n();
  const h = t.hiring;
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const processing = rows.some((v) => v.candidates.some((c) => c.status === "processing"));
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [processing, router]);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{h.subtitle}</p>
      {editing !== "new" && (
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {h.newVacancy}
        </Button>
      )}
      {editing === "new" && <VacancyForm clientId={clientId} initial={{ title: "", requirements: "" }} onDone={() => setEditing(null)} />}
      {rows.length === 0 && editing !== "new" && <EmptyState icon={<Users />} text={h.empty} />}
      {rows.map((v) =>
        editing === v.id ? <VacancyForm key={v.id} clientId={clientId} id={v.id} initial={v} onDone={() => setEditing(null)} /> : <VacancyCard key={v.id} row={v} onEdit={() => setEditing(v.id)} />,
      )}
    </div>
  );
}

function VacancyForm({ clientId, id, initial, onDone }: { clientId: string; id?: string; initial: { title: string; requirements: string }; onDone: () => void }) {
  const { t } = useI18n();
  const h = t.hiring;
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-3 p-5">
      <Field label={h.title}>
        <Input className="w-96" value={d.title} maxLength={150} placeholder={h.titlePlaceholder} onChange={(e) => setD({ ...d, title: e.target.value })} />
      </Field>
      <Field label={h.requirements} hint={h.requirementsHint}>
        <Textarea rows={6} value={d.requirements} maxLength={6000} placeholder={h.requirementsPlaceholder} onChange={(e) => setD({ ...d, requirements: e.target.value })} />
      </Field>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.title.trim()}
          onClick={() =>
            start(async () => {
              const r = await saveVacancy(clientId, id ?? null, d);
              if (r.error) setError(h.errors.invalid);
              else onDone();
            })
          }
        >
          {h.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {h.cancel}
        </Button>
      </div>
    </Card>
  );
}

function VacancyCard({ row, onEdit }: { row: VacancyRow; onEdit: () => void }) {
  const { t } = useI18n();
  const h = t.hiring;
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const sorted = [...row.candidates].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const tone = (v: CandidateRow["verdict"]) => (v === "strong" ? "success" : v === "maybe" ? "warning" : "neutral") as "success" | "warning" | "neutral";
  const upload = () =>
    start(async () => {
      const files = [...(input.current?.files ?? [])];
      if (!files.length) return;
      const body = new FormData();
      body.set("vacancyId", row.id);
      files.forEach((f) => body.append("files", f));
      const res = await fetch("/api/hiring/upload", { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { error?: string; added?: number; skipped?: string[] };
      setMsg(json.error ? h.errors.upload : h.uploaded.replace("{n}", String(json.added ?? 0)) + (json.skipped?.length ? ` ${h.skipped}: ${json.skipped.join(", ")}` : ""));
      if (input.current) input.current.value = "";
      router.refresh();
    });
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{row.title}</span>
            <Badge tone="neutral">{h.count.replace("{n}", String(row.candidates.length))}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted">{row.requirements}</p>
        </div>
        <Button variant="ghost" size="sm" title={h.rescore} disabled={pending || !row.candidates.length} onClick={() => start(() => rescoreVacancy(row.id))}>
          <RefreshCw className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
        <DeleteBtn text={h.confirmDelete} run={() => deleteVacancy(row.id)} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <input ref={input} type="file" multiple accept=".pdf,.docx,.txt,.md,.html,.htm" className="min-w-64 flex-1 text-sm" />
        <Button size="sm" disabled={pending} onClick={upload}>
          {pending ? <Spinner /> : <Upload className="size-4" />}
          {h.upload}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <Textarea rows={2} className="min-w-64 flex-1" value={text} maxLength={30000} placeholder={h.pastePlaceholder} onChange={(e) => setText(e.target.value)} />
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || text.trim().length < 50}
          onClick={() =>
            start(async () => {
              const r = await addResumeText(row.id, text);
              if (!r.error) setText("");
            })
          }
        >
          {h.addText}
        </Button>
      </div>
      {msg && <p className="mt-2 text-sm text-muted">{msg}</p>}
      {sorted.length > 0 && (
        <div className="mt-3 space-y-2">
          {sorted.map((c, i) => (
            <div key={c.id} className="rounded-lg bg-surface-2/60 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 text-muted">{i + 1}.</span>
                <span className="font-semibold">{c.name || c.filename || h.noName}</span>
                {c.contact && <span className="text-xs text-muted">{c.contact}</span>}
                {c.status === "processing" && (
                  <Badge tone="warning">
                    <Spinner /> {h.processing}
                  </Badge>
                )}
                {c.status === "error" && <Badge tone="warning">{(h.errors as Record<string, string>)[c.error ?? ""] ?? h.errors.failed}</Badge>}
                {c.score != null && <Badge tone={tone(c.verdict)}>{`${c.score}/100 · ${c.verdict ? h.verdicts[c.verdict] : ""}`}</Badge>}
                <span className="flex-1" />
                <DeleteBtn text={h.confirmDeleteCandidate} run={() => deleteCandidate(c.id)} />
              </div>
              {c.summary && <p className="mt-1">{c.summary}</p>}
              {(c.strengths.length > 0 || c.gaps.length > 0) && (
                <div className="mt-1 grid gap-2 text-xs sm:grid-cols-2">
                  <div>{c.strengths.map((s, j) => <div key={j} className="text-success">+ {s}</div>)}</div>
                  <div>{c.gaps.map((s, j) => <div key={j} className="text-danger">− {s}</div>)}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
