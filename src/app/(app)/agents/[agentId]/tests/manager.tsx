"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, ChevronDown, FlaskConical, Pencil, Play, Plus, Trash2, Wand2, X } from "lucide-react";
import { deleteScenario, generateTestScenarios, runTests, saveScenario } from "@/app/actions/tests";
import type { TestVerdict } from "@/db/schema";
import { useI18n } from "@/lib/i18n/client";
import { ColumnChart, StatTile } from "@/components/charts";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, Textarea, cx } from "@/components/ui";

type Scenario = {
  id: string;
  name: string;
  mode: "script" | "simulate";
  turns: string[];
  persona: string;
  maxTurns: number;
  criteria: string[];
};
type Run = {
  id: string;
  agentVersion: number;
  status: "running" | "done" | "error";
  total: number;
  passed: number;
  score: number | null;
  cost: number;
  error: string | null;
  createdAt: Date;
};
type Result = {
  id: string;
  scenarioName: string;
  transcript: { role: "user" | "assistant"; content: string }[];
  verdicts: TestVerdict[];
  score: number | null;
  passed: boolean;
  summary: string;
  error: string | null;
  cost: number;
};

export function TestsManager({
  agentId,
  agentVersion,
  scenarios,
  runs,
  selectedRunId,
  results,
}: {
  agentId: string;
  agentVersion: number;
  scenarios: Scenario[];
  runs: Run[];
  selectedRunId: string | null;
  results: Result[];
}) {
  const { t, locale } = useI18n();
  const tt = t.tests;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"run" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Scenario | "new" | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "short", timeStyle: "short" });

  const running = runs.some((r) => r.status === "running");
  // Пока идёт прогон — обновляем страницу, чтобы видеть результаты по мере готовности.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(id);
  }, [running, router]);

  const errText = (code: string) => {
    const key = code.split(":")[0] as keyof typeof tt.errors;
    return tt.errors[key] ?? code;
  };

  const act = (kind: "run" | "generate", fn: () => Promise<{ error?: string; runId?: string }>) =>
    start(async () => {
      setBusy(kind);
      setError(null);
      const r = await fn();
      setBusy(null);
      if (r.error) setError(errText(r.error));
      else if (r.runId) router.replace(`/agents/${agentId}/tests?run=${r.runId}`);
    });

  const selected = runs.find((r) => r.id === selectedRunId) ?? null;
  const history = [...runs].reverse().filter((r) => r.status === "done" && r.score !== null);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">{tt.subtitle}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={pending || running || !scenarios.length} onClick={() => act("run", () => runTests(agentId))}>
          {busy === "run" || running ? <Spinner /> : <Play className="size-4" />}
          {running ? tt.running : `${tt.run} (${scenarios.length})`}
        </Button>
        <Button variant="secondary" disabled={pending || running} onClick={() => act("generate", () => generateTestScenarios(agentId))}>
          {busy === "generate" ? <Spinner /> : <Wand2 className="size-4" />}
          {busy === "generate" ? tt.generating : tt.generate}
        </Button>
        <span className="text-xs text-muted">{tt.costHint}</span>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      {history.length > 1 && (
        <Card className="p-5">
          <ColumnChart
            title={tt.historyTitle}
            data={history.map((r) => ({
              key: r.id,
              label: `v${r.agentVersion}`,
              value: Math.round((r.score ?? 0) * 10) / 10,
              hint: `v${r.agentVersion} · ${fmt.format(new Date(r.createdAt))} · ${r.passed}/${r.total}`,
            }))}
            format={(v) => String(Math.round(v * 10) / 10)}
            tableLabel={t.analytics.showTable}
            chartLabel={t.analytics.showChart}
            height={140}
            labelEvery={1}
          />
        </Card>
      )}

      {runs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {runs.slice(0, 10).map((r) => (
            <Link
              key={r.id}
              href={`/agents/${agentId}/tests?run=${r.id}`}
              replace
              className={cx(
                "rounded-full px-3 py-1 text-xs transition",
                r.id === selectedRunId ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text",
              )}
            >
              v{r.agentVersion} · {fmt.format(new Date(r.createdAt))} ·{" "}
              {r.status === "running" ? "…" : r.status === "error" ? "!" : `${r.passed}/${r.total}`}
            </Link>
          ))}
        </div>
      )}

      {selected && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label={tt.passed}
              value={`${selected.passed} / ${selected.total}`}
              hint={selected.status === "running" ? `${tt.inProgress}: ${results.length}/${selected.total}` : undefined}
            />
            <StatTile label={tt.avgScore} value={selected.score !== null ? `${selected.score.toFixed(1)} / 10` : "—"} />
            <StatTile label={tt.cost} value={`$${selected.cost.toFixed(3)}`} />
            <StatTile
              label={tt.version}
              value={`v${selected.agentVersion}`}
              hint={selected.agentVersion !== agentVersion ? `${tt.currentVersion}: v${agentVersion}` : tt.isCurrent}
            />
          </div>
          {selected.status === "error" && selected.error && <p className="text-sm text-danger">{errText(selected.error)}</p>}
          {results.map((r) => (
            <ResultCard key={r.id} r={r} />
          ))}
        </div>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            {tt.scenarios} ({scenarios.length})
          </h2>
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="size-4" />
            {tt.addScenario}
          </Button>
        </div>
        {editing === "new" && <ScenarioForm agentId={agentId} onClose={() => setEditing(null)} />}
        {scenarios.length === 0 && editing !== "new" ? (
          <EmptyState icon={<FlaskConical />} text={tt.empty} />
        ) : (
          <div className="space-y-2">
            {scenarios.map((s) =>
              editing !== "new" && editing?.id === s.id ? (
                <ScenarioForm key={s.id} agentId={agentId} scenario={s} onClose={() => setEditing(null)} />
              ) : (
                <ScenarioRow key={s.id} s={s} onEdit={() => setEditing(s)} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ r }: { r: Result }) {
  const { t } = useI18n();
  const tt = t.tests;
  const [open, setOpen] = useState(!r.passed);
  return (
    <Card className={cx("overflow-hidden", !r.passed && "border-danger/30")}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span
          className={cx(
            "grid size-7 shrink-0 place-items-center rounded-full text-white",
            r.error ? "bg-amber-500" : r.passed ? "bg-success" : "bg-danger",
          )}
        >
          {r.passed ? <Check className="size-4" /> : <X className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{r.scenarioName}</span>
          <span className="block truncate text-xs text-muted">{r.error ? tt.failedToRun : r.summary}</span>
        </span>
        {r.score !== null && <Badge tone={r.score >= 7 ? "success" : "warning"}>{r.score}/10</Badge>}
        <ChevronDown className={cx("size-4 shrink-0 text-muted transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="grid gap-4 border-t border-border p-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt.dialog}</div>
            {r.transcript.map((m, i) => (
              <div key={i} className={cx("flex", m.role === "user" ? "justify-start" : "justify-end")}>
                <div
                  className={cx(
                    "max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                    m.role === "user" ? "rounded-bl-md border border-border bg-surface" : "rounded-br-md bg-accent-soft",
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {r.error && <p className="text-xs text-danger">{r.error}</p>}
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">{tt.verdicts}</div>
            {r.verdicts.map((v, i) => (
              <div key={i} className="flex gap-2 text-sm">
                <span className={cx("mt-0.5 shrink-0", v.pass ? "text-success" : "text-danger")}>
                  {v.pass ? <Check className="size-4" /> : <X className="size-4" />}
                </span>
                <span>
                  <span className="font-medium">{v.criterion}</span>
                  <span className="block text-xs text-muted">{v.comment}</span>
                </span>
              </div>
            ))}
            <div className="pt-1 text-xs text-muted">${r.cost.toFixed(4)}</div>
          </div>
        </div>
      )}
    </Card>
  );
}

function ScenarioRow({ s, onEdit }: { s: Scenario; onEdit: () => void }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Card className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{s.name}</span>
          <Badge tone={s.mode === "simulate" ? "accent" : "neutral"}>{t.tests.modes[s.mode]}</Badge>
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted">
          {s.mode === "script" ? s.turns.map((x) => `«${x}»`).join(" → ") : s.persona}
        </div>
        <div className="mt-1 text-xs text-muted">
          {t.tests.criteria}: {s.criteria.join(" · ")}
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit} title={t.common.edit}>
        <Pencil className="size-4" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="hover:text-danger"
        disabled={pending}
        title={t.common.delete}
        onClick={() => {
          if (confirm(`${t.common.confirmDelete}\n${s.name}`)) start(async () => void (await deleteScenario(s.id)));
        }}
      >
        <Trash2 className="size-4" />
      </Button>
    </Card>
  );
}

function ScenarioForm({ agentId, scenario, onClose }: { agentId: string; scenario?: Scenario; onClose: () => void }) {
  const { t } = useI18n();
  const tt = t.tests;
  const [mode, setMode] = useState<Scenario["mode"]>(scenario?.mode ?? "script");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="mb-2 p-4">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const lines = (k: string) =>
            String(fd.get(k) ?? "")
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
          start(async () => {
            const r = await saveScenario(agentId, scenario?.id ?? null, {
              name: String(fd.get("name") ?? ""),
              mode,
              turns: lines("turns"),
              persona: String(fd.get("persona") ?? ""),
              maxTurns: Number(fd.get("maxTurns") ?? 4),
              criteria: lines("criteria"),
            });
            if (r.error) setError(tt.errors[r.error as keyof typeof tt.errors] ?? r.error);
            else onClose();
          });
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={tt.name}>
            <Input name="name" defaultValue={scenario?.name} required maxLength={120} />
          </Field>
          <Field label={tt.mode}>
            <div className="flex gap-1 rounded-xl bg-surface-2 p-1">
              {(["script", "simulate"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cx(
                    "rounded-lg px-3 py-1.5 text-sm transition",
                    mode === m ? "bg-surface font-medium shadow-sm" : "text-muted",
                  )}
                >
                  {tt.modes[m]}
                </button>
              ))}
            </div>
          </Field>
        </div>
        {mode === "script" ? (
          <Field label={tt.turns} hint={tt.turnsHint}>
            <Textarea name="turns" rows={3} defaultValue={scenario?.turns.join("\n")} />
          </Field>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
            <Field label={tt.persona} hint={tt.personaHint}>
              <Textarea name="persona" rows={3} defaultValue={scenario?.persona} />
            </Field>
            <Field label={tt.maxTurns}>
              <Input name="maxTurns" type="number" min={1} max={6} defaultValue={scenario?.maxTurns ?? 4} />
            </Field>
          </div>
        )}
        <Field label={tt.criteria} hint={tt.criteriaHint}>
          <Textarea name="criteria" rows={3} defaultValue={scenario?.criteria.join("\n")} />
        </Field>
        <div className="flex items-center justify-end gap-2">
          {error && <p className="mr-auto text-sm text-danger">{error}</p>}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button disabled={pending}>
            {pending && <Spinner />}
            {t.common.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}
