"use client";

import { useState, useTransition } from "react";
import { Check, Hourglass } from "lucide-react";
import { saveWaitingAction } from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Field, Input, Select, Spinner } from "@/components/ui";

export type WaitingView = { enabled: boolean; firstMin: number; secondMin: number; fromHour: number; toHour: number };

/** Напоминания в Telegram, если клиент ждёт ответа человека: пороги и рабочие часы. */
export function WaitingSection({ waiting }: { waiting: WaitingView }) {
  const { t } = useI18n();
  const s = t.integrations;
  const [v, setV] = useState(waiting);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const save = (patch: Partial<WaitingView>) => {
    const next = { ...v, ...patch };
    setV(next);
    start(async () => {
      await saveWaitingAction(next);
      setSaved(true);
    });
  };
  const hours = (max: number) =>
    Array.from({ length: max + 1 }, (_, h) => (
      <option key={h} value={h}>
        {String(h).padStart(2, "0")}:00
      </option>
    ));

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2 font-medium">
        <Hourglass className="size-4 text-accent" />
        {s.waitTitle}
      </div>
      <p className="text-sm text-muted">{s.waitHint}</p>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={v.enabled}
          disabled={pending}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="size-4 accent-[var(--accent)]"
        />
        {s.waitEnabled}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={s.waitFirst}>
          <Input
            type="number"
            min={5}
            max={600}
            defaultValue={v.firstMin}
            disabled={pending || !v.enabled}
            onBlur={(e) => Number(e.target.value) !== v.firstMin && save({ firstMin: Math.max(5, Number(e.target.value) || 20) })}
          />
        </Field>
        <Field label={s.waitSecond}>
          <Input
            type="number"
            min={10}
            max={1440}
            defaultValue={v.secondMin}
            disabled={pending || !v.enabled}
            onBlur={(e) => Number(e.target.value) !== v.secondMin && save({ secondMin: Math.max(10, Number(e.target.value) || 60) })}
          />
        </Field>
        <Field label={s.waitHours}>
          <div className="flex items-center gap-1.5">
            <Select value={v.fromHour} disabled={pending || !v.enabled} onChange={(e) => save({ fromHour: Number(e.target.value) })}>
              {hours(23)}
            </Select>
            <span className="text-muted">—</span>
            <Select value={v.toHour} disabled={pending || !v.enabled} onChange={(e) => save({ toHour: Number(e.target.value) })}>
              {hours(24)}
            </Select>
          </div>
        </Field>
      </div>
      <div className="flex h-5 items-center justify-end text-xs">
        {pending ? (
          <Spinner className="size-3.5 text-muted" />
        ) : (
          saved && (
            <span className="flex items-center gap-1 text-success">
              <Check className="size-3.5" />
              {t.common.saved}
            </span>
          )
        )}
      </div>
    </div>
  );
}
