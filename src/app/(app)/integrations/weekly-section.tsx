"use client";

import { useState, useTransition } from "react";
import { Check, FlaskConical, Play } from "lucide-react";
import { runWeeklyTestsNow, saveWeeklyTestsAction } from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Button, Field, Select, Spinner } from "@/components/ui";

export type WeeklyView = { enabled: boolean; weekday: number; hour: number; lastRunAt: number | null; lastSummary: string | null; scenarios: number; agents: number };

/** Еженедельная проверка агентов автотестами с отчётом в Telegram. */
export function WeeklyTestsSection({ weekly }: { weekly: WeeklyView }) {
  const { t, locale } = useI18n();
  const s = t.integrations;
  const [enabled, setEnabled] = useState(weekly.enabled);
  const [weekday, setWeekday] = useState(weekly.weekday);
  const [hour, setHour] = useState(weekly.hour);
  const [saved, setSaved] = useState(false);
  const [started, setStarted] = useState(false);
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium", timeStyle: "short" });
  const save = (patch: { enabled?: boolean; weekday?: number; hour?: number }) =>
    start(async () => {
      await saveWeeklyTestsAction({ enabled, weekday, hour, ...patch });
      setSaved(true);
    });

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2 font-medium">
        <FlaskConical className="size-4 text-accent" />
        {s.weeklyTitle}
      </div>
      <p className="text-sm text-muted">{s.weeklyHint}</p>
      <p className="text-xs text-muted">{s.weeklyCoverage.replace("{s}", String(weekly.scenarios)).replace("{a}", String(weekly.agents))}</p>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save({ enabled: e.target.checked });
          }}
          className="size-4 accent-[var(--accent)]"
        />
        {s.weeklyEnabled}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={s.weeklyDay}>
          <Select
            value={weekday}
            disabled={pending}
            onChange={(e) => {
              setWeekday(Number(e.target.value));
              save({ weekday: Number(e.target.value) });
            }}
          >
            {s.weekdays.map((d, i) => (
              <option key={i} value={i + 1}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={s.weeklyHour}>
          <Select
            value={hour}
            disabled={pending}
            onChange={(e) => {
              setHour(Number(e.target.value));
              save({ hour: Number(e.target.value) });
            }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span>
          {weekly.lastRunAt ? `${s.weeklyLast}: ${fmt.format(new Date(weekly.lastRunAt))}${weekly.lastSummary ? ` · ${weekly.lastSummary}` : ""}` : s.weeklyNever}
        </span>
        <span className="flex items-center gap-2">
          {saved && !started && (
            <span className="flex items-center gap-1 text-success">
              <Check className="size-3.5" />
              {t.common.saved}
            </span>
          )}
          {started && <span className="text-success">{s.weeklyStarted}</span>}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending || started || weekly.scenarios === 0}
            onClick={() =>
              start(async () => {
                const r = await runWeeklyTestsNow();
                if (r.ok) setStarted(true);
              })
            }
          >
            {pending ? <Spinner /> : <Play className="size-4" />}
            {s.weeklyRunNow}
          </Button>
        </span>
      </div>
    </div>
  );
}
