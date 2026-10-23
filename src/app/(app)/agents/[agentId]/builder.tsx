"use client";
import { hideExampleAction, refreshExamplesAction } from "@/app/actions/examples";
import { InfoHint } from "@/components/hint";

import Link from "next/link";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { BookOpen, Brain, CalendarDays, ChevronDown, ClipboardList, Cpu, FileText, Table2, MessageSquareText, Users, Gift, ScrollText, Sparkles, UserRound, Wrench } from "lucide-react";
import { SKILLS } from "@/lib/agent/skills";
import { compileSystemPrompt, type ClientContext } from "@/lib/agent/compile";
import { EFFORTS, REPLY_LANGUAGES, TONES, type AgentConfig } from "@/lib/agent/types";
import { FULL_CONTEXT_MAX_CHARS, estimateTokens } from "@/lib/kb/text";
import { MODELS, PROVIDER_LABELS, findModel, type Provider } from "@/lib/models";
import { useI18n } from "@/lib/i18n/client";
import { Card, Field, Input, Select, Textarea, cx } from "@/components/ui";
import { CalendarFields } from "./calendar-fields";

const ICONS = ["🤖", "🛍️", "🎯", "📅", "📚", "🎓", "📣", "⭐", "💬", "🦷", "💇", "🏠", "🚗", "🍕", "💼", "🧘"];
const CUSTOM = "__custom";

/** Голоса OpenAI TTS — как в src/lib/speech.ts */
const VOICE_OPTIONS = ["marin", "cedar", "coral", "nova", "shimmer", "sage", "ash", "ballad", "verse", "echo", "onyx", "alloy"];

export type BuilderSource = {
  id: string;
  title: string;
  type: "file" | "url" | "text";
  status: "processing" | "ready" | "error";
  chars: number;
};

/** Свой инструмент клиента — для выбора в агенте */
export type BuilderTool = { id: string; title: string; name: string; enabled: boolean; readOnly: boolean };
/** Анкета клиента — для выбора в агенте */
export type BuilderForm = { id: string; name: string; kind: "form" | "quiz"; enabled: boolean };
export type BuilderDocTemplate = { id: string; name: string; enabled: boolean };
export type BuilderTable = { id: string; name: string; enabled: boolean; rowCount: number };
export type BuilderProgram = { id: string; name: string; enabled: boolean };

export function Builder({
  config,
  onChange,
  client,
  sources,
  googleEmail,
  agentId,
  examples = [],
  tools = [],
  forms = [],
  docTemplates = [],
  tables = [],
  programs = [],
}: {
  config: AgentConfig;
  onChange: (c: AgentConfig) => void;
  client: ClientContext & { id: string };
  sources: BuilderSource[];
  googleEmail: string | null;
  agentId?: string;
  examples?: ExampleItem[];
  tools?: BuilderTool[];
  forms?: BuilderForm[];
  docTemplates?: BuilderDocTemplate[];
  tables?: BuilderTable[];
  programs?: BuilderProgram[];
}) {
  const { t, locale } = useI18n();
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => onChange({ ...config, [key]: value });

  const isKnownModel = Boolean(findModel(config.model));
  const [customMode, setCustomMode] = useState(!isKnownModel);
  const provider = config.model.split(":")[0] as Provider;
  const modelInfo = findModel(config.model);

  // Источники, которые реально попадут агенту (готовые и выбранные), и режим их подачи.
  const selectedIds = config.kbSourceIds ?? null;
  const usedSources = sources.filter(
    (s) => s.status === "ready" && (selectedIds === null || selectedIds.includes(s.id)),
  );
  const kbChars = usedSources.reduce((n, s) => n + s.chars, 0);
  const kbMode = usedSources.length === 0 ? "none" : kbChars <= FULL_CONTEXT_MAX_CHARS ? "full" : "search";

  const prompt = useMemo(
    () =>
      compileSystemPrompt(
        config,
        client,
        kbMode === "none"
          ? undefined
          : {
              kind: "placeholder",
              text: `[${t.kb.modes[kbMode]}: ${usedSources.map((s) => s.title).join(", ")} — ≈${estimateTokens(kbChars).toLocaleString()} ${t.kb.tokens}]`,
            },
      ),
    [config, client, kbMode, usedSources, kbChars, t],
  );

  const toggleSource = (id: string) => {
    const current = selectedIds ?? sources.map((s) => s.id);
    set("kbSourceIds", current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };

  const toggleSkill = (key: string) =>
    set("skills", config.skills.includes(key) ? config.skills.filter((k) => k !== key) : [...config.skills, key]);

  return (
    <div className="space-y-4">
      <Section icon={<UserRound />} id="basics" title={t.builder.sections.basics}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr]">
          <Field label={t.builder.icon}>
            <IconPicker value={config.icon} onChange={(v) => set("icon", v)} />
          </Field>
          <Field label={t.builder.role}>
            <Input
              value={config.role}
              onChange={(e) => set("role", e.target.value)}
              placeholder={t.builder.rolePlaceholder}
            />
          </Field>
        </div>
        <Field label={t.builder.description}>
          <Textarea
            rows={3}
            value={config.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder={t.builder.descriptionPlaceholder}
          />
        </Field>
        <Field label={t.builder.greeting}>
          <Input
            value={config.greeting}
            onChange={(e) => set("greeting", e.target.value)}
            placeholder={t.builder.greetingPlaceholder}
          />
        </Field>
      </Section>

      <Section icon={<Cpu />} id="model" title={t.builder.sections.model}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label={t.builder.model}
            hint={
              modelInfo?.price
                ? `$${modelInfo.price.input} / $${modelInfo.price.output} ${t.builder.perMillion}` +
                  (modelInfo.note ? ` · ${modelInfo.note[locale]}` : "")
                : modelInfo?.note?.[locale]
            }
          >
            <Select
              value={customMode ? CUSTOM : config.model}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setCustomMode(true);
                  set("model", "openrouter:");
                } else {
                  setCustomMode(false);
                  set("model", e.target.value);
                }
              }}
            >
              {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                <optgroup key={p} label={PROVIDER_LABELS[p]}>
                  {MODELS.filter((m) => m.provider === p).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  {p === "openrouter" && <option value={CUSTOM}>{t.builder.customModel}…</option>}
                </optgroup>
              ))}
            </Select>
          </Field>
          {customMode ? (
            <Field label={t.builder.customModel}>
              <Input
                value={config.model.replace(/^openrouter:/, "")}
                onChange={(e) => set("model", `openrouter:${e.target.value.trim()}`)}
                placeholder={t.builder.customModelPlaceholder}
              />
            </Field>
          ) : (
            provider === "anthropic" && (
              <Field label={t.builder.effort} hint={t.builder.effortHint}>
                <Segmented
                  value={config.effort}
                  options={EFFORTS.map((e) => ({ value: e, label: t.builder.efforts[e] }))}
                  onChange={(v) => set("effort", v)}
                />
              </Field>
            )
          )}
        </div>
        <Field label={t.builder.budget} hint={t.builder.budgetHint} className="max-w-xs">
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="decimal"
            value={config.monthlyBudgetUsd ?? ""}
            onChange={(e) => set("monthlyBudgetUsd", e.target.value === "" ? null : Math.max(0, Number(e.target.value)))}
            placeholder="—"
          />
        </Field>
        <Field label={t.builder.memory} hint={t.builder.memoryHint}>
          <Segmented
            value={config.memory === false ? "off" : "on"}
            options={(["on", "off"] as const).map((v) => ({ value: v, label: t.builder.memoryModes[v] }))}
            onChange={(v) => set("memory", v === "on")}
          />
        </Field>
        <Field label={t.builder.voiceReplies} hint={t.builder.voiceRepliesHint}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={config.voiceReplies === false ? "off" : "on"}
              options={(["on", "off"] as const).map((v) => ({ value: v, label: t.builder.memoryModes[v] }))}
              onChange={(v) => set("voiceReplies", v === "on")}
            />
            {config.voiceReplies !== false && (
              <Select value={config.voice || "marin"} onChange={(e) => set("voice", e.target.value)} className="w-40" aria-label={t.builder.voice}>
                {VOICE_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
        <Field label={t.builder.qualityCheck} hint={t.builder.qualityCheckHint}>
          <Segmented
            value={config.qualityCheck === false ? "off" : "on"}
            options={(["on", "off"] as const).map((v) => ({ value: v, label: t.builder.memoryModes[v] }))}
            onChange={(v) => set("qualityCheck", v === "on")}
          />
        </Field>
        <Field label={t.builder.factGuard} hint={t.builder.factGuardHint}>
          <Segmented
            value={config.factGuard ?? "flag"}
            options={(["off", "flag", "block"] as const).map((v) => ({ value: v, label: t.builder.factGuardModes[v] }))}
            onChange={(v) => set("factGuard", v)}
          />
        </Field>
        <Field label={t.builder.answerCheck} hint={t.builder.answerCheckHint}>
          <Segmented
            value={config.answerCheck ? "on" : "off"}
            options={(["off", "on"] as const).map((v) => ({ value: v, label: t.builder.answerCheckModes[v] }))}
            onChange={(v) => set("answerCheck", v === "on")}
          />
        </Field>
        <Field label={t.builder.operatorReview} hint={t.builder.operatorReviewHint}>
          <Segmented
            value={config.operatorReview ? "on" : "off"}
            options={(["off", "on"] as const).map((v) => ({ value: v, label: t.builder.operatorReviewModes[v] }))}
            onChange={(v) => set("operatorReview", v === "on")}
          />
        </Field>
      </Section>

      <Section icon={<Sparkles />} id="skills" title={t.builder.sections.skills} badge={config.skills.length || undefined}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SKILLS.map((s) => {
            const on = config.skills.includes(s.key);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleSkill(s.key)}
                className={cx(
                  "flex items-start gap-3 rounded-xl border p-3 text-left transition",
                  on ? "border-accent bg-accent-soft/60" : "border-border hover:bg-surface-2",
                )}
              >
                <span className="text-lg leading-none">{s.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{s.name[locale]}</span>
                  <span className="block text-xs text-muted">{s.description[locale]}</span>
                </span>
                <span
                  className={cx(
                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border text-[11px] transition",
                    on ? "border-accent bg-accent text-accent-text" : "border-border",
                  )}
                >
                  {on && "✓"}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={<MessageSquareText />} id="style" title={t.builder.sections.style}>
        <Field label={t.builder.tone}>
          <Segmented
            value={config.tone}
            options={TONES.map((v) => ({ value: v, label: t.builder.tones[v] }))}
            onChange={(v) => set("tone", v)}
          />
        </Field>
        {config.tone === "custom" && (
          <Textarea
            rows={2}
            value={config.toneCustom}
            onChange={(e) => set("toneCustom", e.target.value)}
            placeholder={t.builder.toneCustomPlaceholder}
          />
        )}
        <Field label={t.builder.replyLanguage}>
          <Segmented
            value={config.replyLanguage}
            options={REPLY_LANGUAGES.map((v) => ({ value: v, label: t.builder.languages[v] }))}
            onChange={(v) => set("replyLanguage", v)}
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={config.useBrandVoice}
            onChange={(e) => set("useBrandVoice", e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          {t.builder.useBrandVoice}
          {!client.brandVoice && <span className="text-xs text-muted">(—)</span>}
        </label>
        {agentId && <ExamplesList agentId={agentId} items={examples} />}
      </Section>

      <Section icon={<BookOpen />} id="knowledge" title={t.builder.sections.knowledge} badge={usedSources.length || undefined}>
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">{t.builder.kbSources}</span>
            <Link href={`/clients/${client.id}?tab=kb`} className="text-xs text-accent hover:underline">
              {t.builder.kbManage} →
            </Link>
          </div>
          {sources.length === 0 ? (
            <p className="rounded-xl bg-surface-2 px-3 py-3 text-sm text-muted">{t.builder.kbEmpty}</p>
          ) : (
            <>
              <Segmented
                value={selectedIds === null ? "all" : "custom"}
                options={[
                  { value: "all", label: t.builder.kbAll },
                  { value: "custom", label: t.builder.kbChoose },
                ]}
                onChange={(v) => set("kbSourceIds", v === "all" ? null : sources.map((s) => s.id))}
              />
              {selectedIds !== null && (
                <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border p-2">
                  {sources.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(s.id)}
                        onChange={() => toggleSource(s.id)}
                        className="size-4 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {s.status === "ready"
                          ? `≈${estimateTokens(s.chars).toLocaleString()}`
                          : t.kb.status[s.status]}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {kbMode !== "none" && (
                <p className="mt-2 text-xs text-muted">
                  <span className="font-medium text-text">{t.kb.modes[kbMode]}</span> · ≈
                  {estimateTokens(kbChars).toLocaleString()} {t.kb.tokens} — {t.kb.modeHints[kbMode]}
                </p>
              )}
            </>
          )}
        </div>
        <Field label={t.builder.knowledge} hint={t.builder.knowledgeHint}>
          <Textarea
            rows={4}
            value={config.knowledge}
            onChange={(e) => set("knowledge", e.target.value)}
            className="font-mono text-[13px]"
          />
        </Field>
      </Section>

      <Section icon={<ScrollText />} id="rules" title={t.builder.sections.rules}>
        <Field label={t.builder.rules}>
          <Textarea
            rows={4}
            value={config.rules}
            onChange={(e) => set("rules", e.target.value)}
            placeholder={t.builder.rulesPlaceholder}
          />
        </Field>
        <Field label={t.builder.handoff}>
          <Textarea
            rows={2}
            value={config.handoff}
            onChange={(e) => set("handoff", e.target.value)}
            placeholder={t.builder.handoffPlaceholder}
          />
        </Field>
        <Field label={t.builder.leadFields} hint={t.builder.leadFieldsHint}>
          <Input
            value={config.leadFields ?? ""}
            maxLength={400}
            onChange={(e) => set("leadFields", e.target.value)}
            placeholder={t.builder.leadFieldsPlaceholder}
          />
        </Field>
        <Field label={t.builder.extra}>
          <Textarea
            rows={3}
            value={config.extraInstructions}
            onChange={(e) => set("extraInstructions", e.target.value)}
            placeholder={t.builder.extraPlaceholder}
          />
        </Field>
      </Section>

      <Section icon={<CalendarDays />} id="calendar" title={t.builder.sections.calendar} badge={config.calendar.enabled ? config.calendar.services.length || undefined : undefined}>
        <CalendarFields value={config.calendar} onChange={(v) => set("calendar", v)} googleEmail={googleEmail} />
      </Section>

      <Section icon={<Wrench />} id="tools" title={t.builder.sections.tools} badge={(config.toolIds ?? []).length + (config.webSearch ? 1 : 0) || undefined}>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input type="checkbox" checked={Boolean(config.webSearch)} onChange={(e) => set("webSearch", e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
          <span>
            {t.builder.webSearch}
            <span className="block text-xs text-muted">{t.builder.webSearchHint}</span>
          </span>
        </label>
        <p className="text-xs text-muted">{t.builder.toolsHint}</p>
        {tools.length === 0 ? (
          <p className="text-sm text-muted">{t.builder.toolsEmpty}</p>
        ) : (
          <div className="space-y-1.5">
            {tools.map((x) => {
              const on = (config.toolIds ?? []).includes(x.id);
              return (
                <label key={x.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => set("toolIds", on ? (config.toolIds ?? []).filter((i) => i !== x.id) : [...(config.toolIds ?? []), x.id])}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className={cx("min-w-0 flex-1 truncate", !x.enabled && "text-muted line-through")}>{x.title}</span>
                  <code className="shrink-0 font-mono text-xs text-muted">{x.name}</code>
                </label>
              );
            })}
          </div>
        )}
        <Link href={`/clients/${client.id}?tab=tools`} className="text-sm text-accent hover:underline">
          {t.builder.toolsManage}
        </Link>
      </Section>

      <Section icon={<ClipboardList />} id="forms" title={t.builder.sections.forms} badge={(config.formIds ?? []).length || undefined}>
        <p className="text-xs text-muted">{t.builder.formsHint}</p>
        {forms.length === 0 ? (
          <p className="text-sm text-muted">{t.builder.formsEmpty}</p>
        ) : (
          <div className="space-y-1.5">
            {forms.map((x) => {
              const on = (config.formIds ?? []).includes(x.id);
              return (
                <label key={x.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => set("formIds", on ? (config.formIds ?? []).filter((i) => i !== x.id) : [...(config.formIds ?? []), x.id])}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className={cx("min-w-0 flex-1 truncate", !x.enabled && "text-muted line-through")}>{x.name}</span>
                  <span className="shrink-0 text-xs text-muted">{t.forms.kinds[x.kind]}</span>
                </label>
              );
            })}
          </div>
        )}
        <Link href={`/clients/${client.id}?tab=forms`} className="text-sm text-accent hover:underline">
          {t.builder.formsManage}
        </Link>
      </Section>

      <Section icon={<FileText />} id="docs" title={t.builder.sections.docs} badge={(config.docTemplateIds ?? []).length || undefined}>
        <p className="text-xs text-muted">{t.builder.docsHint}</p>
        {docTemplates.length === 0 ? (
          <p className="text-sm text-muted">{t.builder.docsEmpty}</p>
        ) : (
          <div className="space-y-1.5">
            {docTemplates.map((x) => {
              const on = (config.docTemplateIds ?? []).includes(x.id);
              return (
                <label key={x.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => set("docTemplateIds", on ? (config.docTemplateIds ?? []).filter((i) => i !== x.id) : [...(config.docTemplateIds ?? []), x.id])}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className={cx("min-w-0 flex-1 truncate", !x.enabled && "text-muted line-through")}>{x.name}</span>
                </label>
              );
            })}
          </div>
        )}
        <Link href={`/clients/${client.id}?tab=documents`} className="text-sm text-accent hover:underline">
          {t.builder.docsManage}
        </Link>
      </Section>

      <Section icon={<Table2 />} id="data" title={t.builder.sections.data} badge={(config.tableIds ?? []).length || undefined}>
        <p className="text-xs text-muted">{t.builder.dataHint}</p>
        {tables.length === 0 ? (
          <p className="text-sm text-muted">{t.builder.dataEmpty}</p>
        ) : (
          <div className="space-y-1.5">
            {tables.map((x) => {
              const on = (config.tableIds ?? []).includes(x.id);
              return (
                <label key={x.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => set("tableIds", on ? (config.tableIds ?? []).filter((i) => i !== x.id) : [...(config.tableIds ?? []), x.id])}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className={cx("min-w-0 flex-1 truncate", !x.enabled && "text-muted line-through")}>{x.name}</span>
                  <span className="shrink-0 text-xs text-muted">{x.rowCount}</span>
                </label>
              );
            })}
          </div>
        )}
        <Link href={`/clients/${client.id}?tab=data`} className="text-sm text-accent hover:underline">
          {t.builder.dataManage}
        </Link>
      </Section>

      <Section icon={<Gift />} id="loyalty" title={t.builder.sections.loyalty}>
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={Boolean(config.logistics)} onChange={(e) => set("logistics", e.target.checked)} />
          <span>
            <span className="font-medium">{t.builder.deliveryEstimate}</span>
            <span className="block text-xs text-muted">{t.builder.deliveryEstimateHint}</span>
          </span>
        </label>
        <p className="text-xs text-muted">{t.builder.loyaltyHint}</p>
        {programs.length === 0 ? (
          <p className="text-sm text-muted">{t.builder.loyaltyEmpty}</p>
        ) : (
          <Select className="w-72" value={config.loyaltyProgramId ?? ""} onChange={(e) => set("loyaltyProgramId", e.target.value || null)}>
            <option value="">{t.builder.loyaltyOff}</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.enabled ? "" : ` (${t.status.paused})`}
              </option>
            ))}
          </Select>
        )}
        <Link href={`/clients/${client.id}?tab=loyalty`} className="text-sm text-accent hover:underline">
          {t.builder.loyaltyManage}
        </Link>
      </Section>

      <Section icon={<Users />} id="team" title={t.builder.sections.team} collapsible defaultOpen={Boolean(config.team?.enabled)}>
        <p className="text-xs text-muted">{t.builder.teamHint}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={Boolean(config.team?.enabled)}
            onChange={(e) => set("team", { allowed: "", denyText: "", approvals: false, approvers: "owners", ...config.team, enabled: e.target.checked })}
          />
          {t.builder.teamEnabled}
        </label>
        {config.team?.enabled && (
          <>
            <Field label={t.builder.teamAllowed} hint={t.builder.teamAllowedHint}>
              <Textarea rows={4} className="font-mono text-[13px]" value={config.team.allowed} maxLength={5000} placeholder={"@ivan_petrov\n+380 67 123 45 67\n123456789"} onChange={(e) => set("team", { ...config.team!, allowed: e.target.value })} />
            </Field>
            <Field label={t.builder.teamDeny}>
              <Input value={config.team.denyText} maxLength={500} placeholder={t.builder.teamDenyPlaceholder} onChange={(e) => set("team", { ...config.team!, denyText: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={config.team.approvals} onChange={(e) => set("team", { ...config.team!, approvals: e.target.checked })} />
              {t.builder.teamApprovals}
            </label>
            {config.team.approvals && (
              <Field label={t.builder.teamApprovers} hint={t.builder.teamApproversHint}>
                <Select className="w-72" value={config.team.approvers} onChange={(e) => set("team", { ...config.team!, approvers: e.target.value as "owners" | "team" | "both" })}>
                  {(["owners", "team", "both"] as const).map((v) => (
                    <option key={v} value={v}>
                      {t.builder.teamApproverModes[v]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
      </Section>

      <Section icon={<Brain />} id="prompt" title={t.builder.sections.prompt} collapsible defaultOpen={false}>
        <p className="text-xs text-muted">{t.builder.promptHint}</p>
        <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-4 font-mono text-xs leading-relaxed">
          {prompt}
        </pre>
      </Section>
    </div>
  );
}

/** Разделы настройки по порядку — для меню разделов над формой. */
export type ExampleItem = { id: string; question: string; answer: string; liked: boolean };

/** Удачные ответы — образец стиля для агента (обновляются каждое утро; любой можно убрать). */
function ExamplesList({ agentId, items }: { agentId: string; items: ExampleItem[] }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="flex items-center gap-1 text-sm font-medium">
        {t.builder.examplesTitle}
        <InfoHint>{t.builder.examplesHint}</InfoHint>
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => void (await refreshExamplesAction(agentId)))}
          className="ml-auto text-xs font-normal text-accent hover:underline disabled:opacity-50"
        >
          {t.builder.examplesRefresh}
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted">{t.builder.examplesEmpty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((e) => (
            <li key={e.id} className="group relative rounded-xl bg-surface-2/60 px-3 py-2 text-xs">
              <div className="truncate text-muted">
                {e.liked ? "👍 " : "✓ "}
                {e.question}
              </div>
              <div className="mt-0.5 line-clamp-2">{e.answer}</div>
              <button
                type="button"
                disabled={pending}
                title={t.builder.examplesHide}
                onClick={() => start(async () => void (await hideExampleAction(agentId, e.id)))}
                className="absolute top-1.5 right-2 hidden text-muted hover:text-danger group-hover:block"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const BUILDER_SECTIONS = ["basics", "model", "skills", "style", "knowledge", "rules", "calendar", "tools", "forms", "docs", "data", "loyalty", "team", "prompt"] as const;

function Section({
  id,
  icon,
  title,
  badge,
  collapsible,
  defaultOpen = true,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  badge?: number;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const header = (
    <span className="flex items-center gap-2.5 font-semibold [&>svg]:size-[18px] [&>svg]:text-accent">
      {icon}
      {title}
      {badge !== undefined && (
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">{badge}</span>
      )}
    </span>
  );
  return (
    <Card className="scroll-mt-20 p-5" id={`section-${id}`}>
      {collapsible ? (
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between">
          {header}
          <ChevronDown className={cx("size-4 text-muted transition", open && "rotate-180")} />
        </button>
      ) : (
        header
      )}
      {open && <div className="mt-4 space-y-4">{children}</div>}
    </Card>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition",
            o.value === value ? "bg-surface font-medium text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="grid size-10 place-items-center rounded-xl border border-border bg-surface text-xl hover:bg-surface-2"
      >
        {value}
      </button>
      {open && (
        <div className="absolute z-20 mt-2 grid w-56 grid-cols-6 gap-1 rounded-xl border border-border bg-surface p-2 shadow-xl">
          {ICONS.map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onChange(i);
                setOpen(false);
              }}
              className={cx("grid size-8 place-items-center rounded-lg text-lg hover:bg-surface-2", i === value && "bg-accent-soft")}
            >
              {i}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
