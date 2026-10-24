"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Bot, Clock, Megaphone, Wallet } from "lucide-react";
import { saveGeneralAction } from "@/app/actions/general";
import type { General } from "@/lib/general";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Select, Switch } from "@/components/ui";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Number(v)));

export function GeneralForm({ initial, spent, models, timeZones }: { initial: General; spent: number; models: { id: string; label: string }[]; timeZones: string[] }) {
  const { t } = useI18n();
  const g = t.general;
  const [v, setV] = useState<General>(initial);
  const [status, setStatus] = useState<"saved" | "error" | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof General>(k: K, val: General[K]) => {
    setV((x) => ({ ...x, [k]: val }));
    setStatus(null);
  };
  const setAgent = <K extends keyof General["newAgent"]>(k: K, val: General["newAgent"][K]) => set("newAgent", { ...v.newAgent, [k]: val });
  const setJob = (k: keyof General["jobs"], val: boolean) => set("jobs", { ...v.jobs, [k]: val });
  const zones = timeZones.includes(v.timeZone) ? timeZones : [v.timeZone, ...timeZones];
  const modelList = models.some((m) => m.id === v.newAgent.model) ? models : [{ id: v.newAgent.model, label: v.newAgent.model }, ...models];

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setStatus((await saveGeneralAction(v)).ok ? "saved" : "error"));
      }}
    >
      <Section icon={<Clock className="size-4" />} title={g.studio}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={g.studioName} hint={g.studioNameHint}>
            <Input value={v.studioName} maxLength={60} onChange={(e) => set("studioName", e.target.value)} />
          </Field>
          <Field label={g.timeZone} hint={g.timeZoneHint}>
            <Select value={v.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={g.currency} hint={g.currencyHint}>
            <Select value={v.currency} onChange={(e) => set("currency", e.target.value as General["currency"])}>
              {(["UAH", "USD", "EUR"] as const).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={g.locale} hint={g.localeHint}>
            <Select value={v.locale} onChange={(e) => set("locale", e.target.value as General["locale"])}>
              <option value="ru">Русский</option>
              <option value="uk">Українська</option>
            </Select>
          </Field>
        </div>
      </Section>

      <Section icon={<Bot className="size-4" />} title={g.newAgent} hint={g.newAgentHint}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={g.model}>
            <Select value={v.newAgent.model} onChange={(e) => setAgent("model", e.target.value)}>
              {modelList.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={g.replyLanguage}>
            <Select value={v.newAgent.replyLanguage} onChange={(e) => setAgent("replyLanguage", e.target.value as General["newAgent"]["replyLanguage"])}>
              {(["auto", "ru", "uk", "en"] as const).map((l) => (
                <option key={l} value={l}>
                  {g.languages[l]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={g.agentBudget}>
            <Input type="number" min={0} step="0.5" placeholder={g.noLimit} value={v.newAgent.monthlyBudgetUsd ?? ""} onChange={(e) => setAgent("monthlyBudgetUsd", num(e.target.value))} />
          </Field>
        </div>
        <div className="divide-y divide-border">
          <Switch label={g.aiDisclosure} checked={v.newAgent.aiDisclosure} onChange={(x) => setAgent("aiDisclosure", x)} />
          <Switch label={g.quickReplies} checked={v.newAgent.quickReplies} onChange={(x) => setAgent("quickReplies", x)} />
          <Switch label={g.streaming} checked={v.newAgent.streaming} onChange={(x) => setAgent("streaming", x)} />
          <Switch label={g.answerCheck} checked={v.newAgent.answerCheck} onChange={(x) => setAgent("answerCheck", x)} />
        </div>
      </Section>

      <Section icon={<Megaphone className="size-4" />} title={g.broadcasts}>
        <div className="flex flex-wrap items-end gap-3">
          <span className="pb-2 text-sm font-medium">{g.quiet}</span>
          <Field label={g.quietFrom}>
            <Select className="w-28" value={v.quietFrom} onChange={(e) => set("quietFrom", Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
              ))}
            </Select>
          </Field>
          <Field label={g.quietTo}>
            <Select className="w-28" value={v.quietTo} onChange={(e) => set("quietTo", Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted">{g.quietHint}</p>
        <Field label={g.dailyLimit} hint={g.dailyLimitHint} className="max-w-xs">
          <Input type="number" min={1} step={1} placeholder={g.noLimit} value={v.broadcastDailyLimit ?? ""} onChange={(e) => set("broadcastDailyLimit", e.target.value.trim() === "" ? null : Math.max(1, Math.round(Number(e.target.value))))} />
        </Field>
      </Section>

      <Section icon={<Wallet className="size-4" />} title={g.spend}>
        <div className="flex flex-wrap items-end gap-4">
          <Field label={g.studioLimit} hint={g.studioLimitHint} className="max-w-xs">
            <Input type="number" min={1} step={1} placeholder={g.noLimit} value={v.studioMonthlyLimitUsd ?? ""} onChange={(e) => set("studioMonthlyLimitUsd", num(e.target.value) || null)} />
          </Field>
          <div className="pb-2 text-sm text-muted">
            {g.spentNow}: <span className="font-medium text-text">${spent.toFixed(2)}</span>
            {v.studioMonthlyLimitUsd ? ` · ${Math.round((spent / v.studioMonthlyLimitUsd) * 100)}%` : ""}
          </div>
        </div>
        <div className="text-sm font-medium">{g.jobs}</div>
        <div className="divide-y divide-border">
          <Switch label={g.jobQuality} checked={v.jobs.qualityCheck} onChange={(x) => setJob("qualityCheck", x)} />
          <Switch label={g.jobGaps} checked={v.jobs.gapsAnalysis} onChange={(x) => setJob("gapsAnalysis", x)} />
          <Switch label={g.jobReview} checked={v.jobs.agentReview} onChange={(x) => setJob("agentReview", x)} />
        </div>
      </Section>

      <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-2xl border border-border bg-surface/95 p-3 backdrop-blur">
        {status === "saved" && <span className="text-sm text-success">{g.saved}</span>}
        {status === "error" && <span className="text-sm text-danger">{g.error}</span>}
        <Button type="submit" disabled={pending}>
          {g.save}
        </Button>
      </div>
    </form>
  );
}

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-5">
      <div>
        <div className="flex items-center gap-2 font-semibold">
          <span className="text-accent">{icon}</span>
          {title}
        </div>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}
