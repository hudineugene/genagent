"use client";

import { useEffect, useState } from "react";
import { History, RotateCcw, X } from "lucide-react";
import { listVersions, type AgentVersionItem } from "@/app/actions/agents";
import { SKILL_MAP } from "@/lib/agent/skills";
import { emptyConfig } from "@/lib/agent/templates";
import type { AgentConfig } from "@/lib/agent/types";
import { findModel } from "@/lib/models";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Spinner, cx } from "@/components/ui";
import type { BuilderSource } from "./builder";

type Snapshot = { name: string; config: AgentConfig };
type Field = keyof AgentConfig | "name";

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
      calendar: b.sections.calendar,
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
      case "skills":
        return c.skills.map((k) => SKILL_MAP.get(k)?.name[locale] ?? k).join(", ") || "—";
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
                                <dd className="mt-1 grid gap-1 text-sm">
                                  <span className="whitespace-pre-wrap rounded-lg bg-danger/8 px-2 py-1 text-danger line-through decoration-danger/40">
                                    {from}
                                  </span>
                                  <span className="whitespace-pre-wrap rounded-lg bg-success/10 px-2 py-1 text-success">
                                    {to}
                                  </span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        {changes.length > 0 && (
                          <div className="mt-4 flex justify-end">
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
