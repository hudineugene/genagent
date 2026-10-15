"use client";

import { useState, useTransition } from "react";
import { Check, Moon, Send } from "lucide-react";
import { saveDailyDigestAction, sendDailyDigestNow } from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Button, Field, Select, Spinner } from "@/components/ui";

export type DailyView = { enabled: boolean; hour: number };

/** Ежедневная сводка по агентам в Telegram: кто написал, кому ответил агент, кто ждёт человека. */
export function DailyDigestSection({ daily }: { daily: DailyView }) {
  const { t } = useI18n();
  const s = t.integrations;
  const [enabled, setEnabled] = useState(daily.enabled);
  const [hour, setHour] = useState(daily.hour);
  const [status, setStatus] = useState<"saved" | "sent" | "empty" | null>(null);
  const [pending, start] = useTransition();
  const save = (patch: { enabled?: boolean; hour?: number }) =>
    start(async () => {
      await saveDailyDigestAction({ enabled, hour, ...patch });
      setStatus("saved");
    });

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2 font-medium">
        <Moon className="size-4 text-accent" />
        {s.dailyTitle}
      </div>
      <p className="text-sm text-muted">{s.dailyHint}</p>
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
        {s.dailyEnabled}
      </label>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={s.dailyHour}>
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
        <span className="flex items-center gap-2 text-xs">
          {status === "saved" && (
            <span className="flex items-center gap-1 text-success">
              <Check className="size-3.5" />
              {t.common.saved}
            </span>
          )}
          {status === "sent" && <span className="text-success">{s.dailySent}</span>}
          {status === "empty" && <span className="text-muted">{s.dailyEmpty}</span>}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await sendDailyDigestNow();
                setStatus(r.ok ? "sent" : "empty");
              })
            }
          >
            {pending ? <Spinner /> : <Send className="size-4" />}
            {s.dailySendNow}
          </Button>
        </span>
      </div>
    </div>
  );
}
