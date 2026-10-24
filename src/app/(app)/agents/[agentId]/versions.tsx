"use client";

import { useEffect, useState, useTransition } from "react";
import { History, RotateCcw, X } from "lucide-react";
import { experimentStatsAction, listVersions, startExperimentAction, stopExperimentAction, type AgentVersionItem } from "@/app/actions/agents";
import { SKILL_MAP } from "@/lib/agent/skills";
import { emptyConfig } from "@/lib/agent/templates";
import type { AgentConfig } from "@/lib/agent/types";
import { findModel } from "@/lib/models";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Spinner, cx } from "@/components/ui";
import type { BuilderSource } from "./builder";

type Snapshot = { name: string; config: AgentConfig };
// Отметка «из шаблона студии» — служебная, в сравнении версий не показываем
type Field = Exclude<keyof AgentConfig, "studioTemplate"> | "name";

const FIELDS: Field[] = [
  "name",
  "icon",
  "role",
  "description",
  "greeting",
  "model",
  "effort",
  "skills",
  "tone",
  "toneCustom",
  "replyLanguage",
  "useBrandVoice",
  "kbSourceIds",
  "knowledge",
  "rules",
  "handoff",
  "extraInstructions",
  "monthlyBudgetUsd",
  "memory",
  "voiceReplies",
  "voice",
  "qualityCheck",
  "factGuard",
  "calendar",
  "toolIds",
  "webSearch",
  "operatorReview",
  "formIds",
  "procedureIds",
  "docTemplateIds",
  "tableIds",
  "team",
  "loyaltyProgramId",
  "logistics",
  "pricing",
  "payments",
  "learning",
  "aiDisclosure",
  "streaming",
  "quickReplies",
];

export function VersionsPanel({
  agentId,
  currentVersion,
  current,
  sources,
  onClose,
  onRestore,
}: {
  agentId: string;
  currentVersion: number;
  current: Snapshot;
  sources: BuilderSource[];
  onClose: () => void;
  onRestore: (v: Snapshot) => void;
}) {
  const { t, locale } = useI18n();
  const [versions, setVersions] = useState<AgentVersionItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium", timeStyle: "short" });

  useEffect(() => {
    listVersions(agentId).then(setVersions);
  }, [agentId, currentVersion]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label = (f: Field): string => {
    const b = t.builder;
    const map: Record<Field, string> = {
      name: b.name,
      icon: b.icon,
      role: b.role,
      description: b.description,
      greeting: b.greeting,
      model: b.model,
      effort: b.effort,
      skills: b.sections.skills,
      tone: b.tone,
      toneCustom: `${b.tone} (${b.tones.custom})`,
      replyLanguage: b.replyLanguage,
      useBrandVoice: b.useBrandVoice,
      kbSourceIds: b.kbSources,
      knowledge: b.knowledge,
      rules: b.rules,
      handoff: b.handoff,
      leadFields: b.leadFields,
      extraInstructions: b.extra,
      monthlyBudgetUsd: b.budget,
      memory: b.memory,
      voiceReplies: b.voiceReplies,
      voice: b.voice,
      qualityCheck: b.qualityCheck,
      factGuard: b.factGuard,
      answerCheck: b.answerCheck,
      aiDisclosure: b.aiDisclosure,
      streaming: b.streaming,
      quickReplies: b.quickReplies,
      calendar: b.sections.calendar,
      toolIds: b.sections.tools,
      webSearch: b.webSearch,
      operatorReview: b.operatorReview,
      formIds: b.sections.forms,
      procedureIds: b.procedures,
      docTemplateIds: b.sections.docs,
      tableIds: b.sections.data,
      team: b.sections.team,
      loyaltyProgramId: b.sections.loyalty,
      logistics: b.deliveryEstimate,
      pricing: b.pricingCalc,
      payments: b.payments,
      learning: b.learning,
    };
    return map[f];
  };

  const show = (f: Field, s: Snapshot): string => {
    const c = s.config;
    switch (f) {
      case "name":
        return s.name;
      case "model":
        return findModel(c.model)?.label ?? c.model;
      case "effort":
        return t.builder.efforts[c.effort];
      case "tone":
        return t.builder.tones[c.tone];
      case "replyLanguage":
        return t.builder.languages[c.replyLanguage];
      case "factGuard":
        return t.builder.factGuardModes[c.factGuard ?? "flag"];
      case "useBrandVoice":
        return c.useBrandVoice ? t.versions.on : t.versions.off;
      case "webSearch":
        return c.webSearch ? t.versions.on : t.versions.off;
      case "operatorReview":
        return c.operatorReview ? t.versions.on : t.versions.off;
      case "skills":
        return c.skills.map((k) => SKILL_MAP.get(k)?.name[locale] ?? k).join(", ") || "—";
      case "toolIds":
        return String((c.toolIds ?? []).length || "—");
      case "formIds":
        return String((c.formIds ?? []).length || "—");
      case "procedureIds":
        return String((c.procedureIds ?? []).length || "—");
      case "docTemplateIds":
        return String((c.docTemplateIds ?? []).length || "—");
      case "aiDisclosure":
        return c.aiDisclosure?.enabled ? t.versions.on : t.versions.off;
      case "streaming":
        return c.streaming ? t.versions.on : t.versions.off;
      case "quickReplies":
        return c.quickReplies ? t.versions.on : t.versions.off;
      case "learning":
        return c.learning ? t.versions.on : t.versions.off;
      case "pricing":
        return c.pricing ? t.versions.on : t.versions.off;
      case "payments":
        return c.payments ? t.versions.on : t.versions.off;
      case "logistics":
        return c.logistics ? t.versions.on : t.versions.off;
      case "loyaltyProgramId":
        return c.loyaltyProgramId ? t.versions.on : t.versions.off;
      case "team":
        return c.team?.enabled ? t.versions.on : t.versions.off;
      case "tableIds":
        return String((c.tableIds ?? []).length || "—");
      case "kbSourceIds":
        return c.kbSourceIds == null
          ? t.versions.allSources
          : c.kbSourceIds.map((id) => sources.find((x) => x.id === id)?.title ?? "?").join(", ") || "—";
      case "calendar": {
        const k = c.calendar;
        if (!k?.enabled) return t.versions.off;
        return [
          k.calendarId || "—",
          `${[1, 2, 3, 4, 5, 6, 0].filter((d) => k.workDays.includes(d)).map((d) => t.builder.calendar.weekdays[d]).join(", ")} ${k.workStart}–${k.workEnd}`,
          k.services.map((x) => `${x.name} ${x.minutes}`).join(", ") || `${k.slotMinutes} ${t.builder.calendar.minutes}`,
          `${k.minNoticeHours}h / ${k.horizonDays}d`,
        ].join(" · ");
      }
      default: {
        const v = String(c[f] ?? "");
        return v.length > 300 ? `${v.slice(0, 300)}…` : v || "—";
      }
    }
  };

  const normalize = (v: AgentVersionItem): Snapshot => ({
    name: v.name ?? current.name,
    config: { ...emptyConfig(), ...v.config },
  });

  const diff = (v: AgentVersionItem) => {
    const snap = normalize(v);
    return FIELDS.filter((f) => show(f, snap) !== show(f, current)).map((f) => ({
      f,
      from: show(f, current),
      to: show(f, snap),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2 font-semibold">
            <History className="size-5 text-accent" />
            {t.versions.title}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} title={t.versions.close}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <AbTest agentId={agentId} versions={versions ?? []} onPromote={(v) => onRestore(normalize(v))} />
          {!versions ? (
            <div className="grid place-items-center py-16 text-muted">
              <Spinner className="size-6" />
            </div>
          ) : versions.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted">{t.versions.empty}</p>
          ) : (
            <ol className="space-y-2">
              {versions.map((v) => {
                const isCurrent = v.version === currentVersion;
                const open = openId === v.id;
                const changes = open ? diff(v) : [];
                return (
                  <li key={v.id} className={cx("rounded-xl border", open ? "border-accent/50" : "border-border")}>
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : v.id)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-sm font-semibold">
                        v{v.version}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{v.name ?? "—"}</span>
                        <span className="block text-xs text-muted">
                          {fmt.format(new Date(v.createdAt))}
                          {v.author && ` · ${v.author}`}
                        </span>
                      </span>
                      {isCurrent && <Badge tone="accent">{t.versions.current}</Badge>}
                    </button>
                    {open && (
                      <div className="border-t border-border px-4 py-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                          {t.versions.diff}
                        </div>
                        {changes.length === 0 ? (
                          <p className="text-sm text-muted">{t.versions.same}</p>
                        ) : (
                          <dl className="space-y-3">
                            {changes.map(({ f, from, to }) => (
                              <div key={f}>
                                <dt className="text-xs font-medium text-muted">{label(f)}</dt>
                                <dd className="mt-1 text-sm">
                                  <WordDiff from={from} to={to} />
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        {changes.length > 0 && (
                          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                            <StartAb agentId={agentId} versionId={v.id} version={v.version} />
                            <Button size="sm" onClick={() => onRestore(normalize(v))}>
                              <RotateCcw className="size-4" />
                              {t.versions.restore} v{v.version}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}

type Stats = Awaited<ReturnType<typeof experimentStatsAction>>;

/** Идущая A/B-проверка: доля, итоги A и B, «сделать B основной» или остановить. */
function AbTest({ agentId, versions, onPromote }: { agentId: string; versions: AgentVersionItem[]; onPromote: (v: AgentVersionItem) => void }) {
  const { t } = useI18n();
  const a = t.versions.ab;
  const [stats, setStats] = useState<Stats | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    experimentStatsAction(agentId).then(setStats);
  }, [agentId]);
  if (!stats?.exp) return null;
  const exp = stats.exp;
  const b = versions.find((v) => v.id === exp.versionId);
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
  const usd = (x: number | null) => (x === null ? "—" : `$${x.toFixed(3)}`);
  return (
    <div className="mb-4 space-y-3 rounded-xl border border-accent/50 bg-accent-soft/40 p-4 text-sm">
      <div className="font-semibold">{a.running.replace("{v}", String(exp.version)).replace("{share}", String(exp.share))}</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 font-medium" />
            <th className="py-1 font-medium">{a.conversations}</th>
            <th className="py-1 font-medium">{a.resolved}</th>
            <th className="py-1 font-medium">{a.handoffs}</th>
            <th className="py-1 font-medium">{a.cost}</th>
          </tr>
        </thead>
        <tbody>
          {(["A", "B"] as const).map((k) => (
            <tr key={k}>
              <td className="py-1 font-semibold">{k === "A" ? a.current : `B · v${exp.version}`}</td>
              <td className="py-1 tabular-nums">{stats[k].conversations}</td>
              <td className="py-1 tabular-nums">{pct(stats[k].resolved)}</td>
              <td className="py-1 tabular-nums">{pct(stats[k].handoffRate)}</td>
              <td className="py-1 tabular-nums">{usd(stats[k].costPerConversation)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">{a.hint}</p>
      <div className="flex flex-wrap gap-2">
        {b && (
          <Button size="sm" disabled={pending} onClick={() => start(async () => { await stopExperimentAction(agentId); onPromote(b); })}>
            {a.promote}
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => { await stopExperimentAction(agentId); setStats(await experimentStatsAction(agentId)); })}>
          {a.stop}
        </Button>
      </div>
    </div>
  );
}

/** Запустить A/B: эта версия отвечает в доле новых разговоров. */
function StartAb({ agentId, versionId, version }: { agentId: string; versionId: string; version: number }) {
  const { t } = useI18n();
  const a = t.versions.ab;
  const [share, setShare] = useState(10);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  if (done) return <span className="text-xs text-success">{a.started}</span>;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <select className="h-8 rounded-lg border border-border bg-surface px-1" value={share} onChange={(e) => setShare(Number(e.target.value))}>
        {[5, 10, 20, 50].map((x) => (
          <option key={x} value={x}>
            {x}%
          </option>
        ))}
      </select>
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => { await startExperimentAction(agentId, versionId, share); setDone(true); })}>
        {a.start.replace("{v}", String(version))}
      </Button>
    </span>
  );
}

type Seg = { t: string; k: "same" | "del" | "add" };

/** Разница по словам (наибольшая общая подпоследовательность); слишком длинные тексты — целиком «было/стало». */
function wordDiff(a: string, b: string): Seg[] | null {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  if (x.length * y.length > 400_000) return null;
  const m = x.length;
  const n = y.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Seg[] = [];
  const push = (t: string, k: Seg["k"]) => {
    const last = out[out.length - 1];
    if (last && last.k === k) last.t += t;
    else out.push({ t, k });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      push(x[i], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push(x[i++], "del");
    else push(y[j++], "add");
  }
  while (i < m) push(x[i++], "del");
  while (j < n) push(y[j++], "add");
  return out;
}

/** Было → стало одним текстом: убранное — зачёркнуто красным, добавленное — зелёным. */
function WordDiff({ from, to }: { from: string; to: string }) {
  const segs = wordDiff(from, to);
  if (!segs)
    return (
      <span className="grid gap-1">
        <span className="whitespace-pre-wrap rounded-lg bg-danger/8 px-2 py-1 text-danger line-through decoration-danger/40">{from}</span>
        <span className="whitespace-pre-wrap rounded-lg bg-success/10 px-2 py-1 text-success">{to}</span>
      </span>
    );
  return (
    <span className="block whitespace-pre-wrap rounded-lg bg-surface-2/60 px-2 py-1.5 leading-relaxed">
      {segs.map((s, i) =>
        s.k === "same" ? (
          <span key={i}>{s.t}</span>
        ) : s.k === "del" ? (
          <del key={i} className="rounded bg-danger/12 text-danger decoration-danger/50">
            {s.t}
          </del>
        ) : (
          <ins key={i} className="rounded bg-success/15 text-success no-underline">
            {s.t}
          </ins>
        ),
      )}
    </span>
  );
}
