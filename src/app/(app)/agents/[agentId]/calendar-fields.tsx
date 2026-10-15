"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { checkCalendar } from "@/app/actions/integrations";
import type { CalendarConfig } from "@/lib/agent/types";
import { useI18n } from "@/lib/i18n/client";
import { Button, Field, Input, Select, Spinner, cx } from "@/components/ui";

const TIMEZONES = [
  "Europe/Kyiv",
  "Europe/Warsaw",
  "Europe/Berlin",
  "Europe/Prague",
  "Europe/Vienna",
  "Europe/Rome",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Vilnius",
  "Europe/Riga",
  "Europe/Tallinn",
  "Europe/Chisinau",
  "Europe/Bucharest",
  "Europe/Istanbul",
  "Asia/Tbilisi",
  "Asia/Dubai",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Toronto",
];

/** Порядок дней в интерфейсе: с понедельника. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export function CalendarFields({
  value,
  onChange,
  googleEmail,
}: {
  value: CalendarConfig;
  onChange: (v: CalendarConfig) => void;
  googleEmail: string | null;
}) {
  const { t } = useI18n();
  const c = t.builder.calendar;
  const set = <K extends keyof CalendarConfig>(key: K, v: CalendarConfig[K]) => onChange({ ...value, [key]: v });
  const [check, setCheck] = useState<{ ok: boolean; code?: string } | null>(null);
  const [checking, start] = useTransition();

  return (
    <>
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
          className="mt-0.5 size-4 accent-[var(--accent)]"
        />
        <span>
          <span className="font-medium">{c.enable}</span>
          <span className="block text-xs text-muted">{c.enableHint}</span>
        </span>
      </label>

      {value.enabled && (
        <>
          {!googleEmail && (
            <div className="flex gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span>
                {c.noGoogle}{" "}
                <Link href="/integrations" className="text-accent hover:underline">
                  →
                </Link>
              </span>
            </div>
          )}

          <Field label={c.calendarId} hint={c.calendarIdHint}>
            <div className="flex gap-2">
              <Input
                value={value.calendarId}
                onChange={(e) => {
                  set("calendarId", e.target.value.trim());
                  setCheck(null);
                }}
                placeholder="name@gmail.com"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={checking || !value.calendarId}
                onClick={() => start(async () => setCheck(await checkCalendar(value.calendarId)))}
                className="shrink-0"
              >
                {checking ? <Spinner /> : <ShieldCheck className="size-4" />}
                {checking ? c.checking : c.check}
              </Button>
            </div>
          </Field>
          {check && (
            <p className={cx("flex items-center gap-1.5 text-sm", check.ok ? "text-success" : "text-danger")}>
              {check.ok ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
              {check.ok ? c.ok : (c.errors[check.code as keyof typeof c.errors] ?? c.errors.calendar_error)}
            </p>
          )}
          {googleEmail && (
            <p className="text-xs text-muted">
              {c.share}: <code className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono">{googleEmail}</code>
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={c.timezone}>
              <Select value={value.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {(TIMEZONES.includes(value.timezone) ? TIMEZONES : [value.timezone, ...TIMEZONES]).map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={c.workHours}>
              <div className="flex items-center gap-2">
                <Input type="time" step={1800} value={value.workStart} onChange={(e) => e.target.value && set("workStart", e.target.value)} />
                <span className="text-muted">–</span>
                <Input type="time" step={1800} value={value.workEnd} onChange={(e) => e.target.value && set("workEnd", e.target.value)} />
              </div>
            </Field>
          </div>

          <Field label={c.workDays}>
            <div className="flex flex-wrap gap-1.5">
              {WEEK.map((d) => {
                const on = value.workDays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() =>
                      set("workDays", on ? value.workDays.filter((x) => x !== d) : [...value.workDays, d].sort())
                    }
                    className={cx(
                      "h-9 min-w-11 rounded-lg border px-2 text-sm transition",
                      on ? "border-accent bg-accent-soft font-medium text-text" : "border-border text-muted hover:bg-surface-2",
                    )}
                  >
                    {c.weekdays[d]}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={c.slotMinutes}>
              <NumberInput min={10} max={480} step={5} value={value.slotMinutes} onChange={(v) => set("slotMinutes", v)} />
            </Field>
            <Field label={c.minNotice}>
              <NumberInput min={0} max={168} value={value.minNoticeHours} onChange={(v) => set("minNoticeHours", v)} />
            </Field>
            <Field label={c.horizon}>
              <NumberInput min={1} max={180} value={value.horizonDays} onChange={(v) => set("horizonDays", Math.round(v))} />
            </Field>
          </div>

          <Field label={c.services} hint={c.servicesHint}>
            <div className="space-y-2">
              {value.services.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={s.name}
                    placeholder={c.serviceName}
                    onChange={(e) =>
                      set(
                        "services",
                        value.services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                  />
                  <NumberInput
                    min={10}
                    max={480}
                    step={5}
                    value={s.minutes}
                    className="w-24 shrink-0"
                    onChange={(v) => set("services", value.services.map((x, j) => (j === i ? { ...x, minutes: Math.round(v) } : x)))}
                  />
                  <span className="shrink-0 text-sm text-muted">{c.minutes}</span>
                  <button
                    type="button"
                    onClick={() => set("services", value.services.filter((_, j) => j !== i))}
                    className="shrink-0 rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-danger"
                    aria-label="×"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              {value.services.length < 30 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => set("services", [...value.services, { name: "", minutes: value.slotMinutes }])}
                >
                  <Plus className="size-4" />
                  {c.addService}
                </Button>
              )}
            </div>
          </Field>
        </>
      )}
    </>
  );
}

/** Число с границами: пока пользователь печатает, значение не подрезается; границы применяются при выходе из поля. */
function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      className={className}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => {
        if (draft === null) return;
        const n = Number(draft);
        onChange(draft === "" || !Number.isFinite(n) ? value : clamp(n));
        setDraft(null);
      }}
    />
  );
}
