"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowLeft, ArrowRight, Bot, Building2, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Spinner, Textarea, cx } from "./ui";

const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

/**
 * Новый клиент за три шага: основное → о компании и голос бренда → проверка и что дальше (открыть клиента или сразу
 * создать первого агента). Все поля в одной форме — шаги только прячут лишнее, при отправке уходит всё.
 */
export function NewClientWizard({ action }: { action: (formData: FormData) => Promise<void> }) {
  const { t } = useI18n();
  const w = t.shell.wizard;
  const c = t.clients;
  const form = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState(false);
  const [summary, setSummary] = useState({ name: "", industry: "", website: "", color: COLORS[0] });
  const steps = [w.step1, w.step2, w.step3];

  const next = () => {
    const f = form.current;
    if (!f) return;
    const name = (f.elements.namedItem("name") as HTMLInputElement).value.trim();
    if (step === 0 && !name) {
      setError(true);
      (f.elements.namedItem("name") as HTMLInputElement).focus();
      return;
    }
    setError(false);
    const val = (k: string) => ((f.elements.namedItem(k) as HTMLInputElement | null)?.value ?? "").trim();
    const color = (f.querySelector<HTMLInputElement>('input[name="color"]:checked')?.value ?? COLORS[0]);
    setSummary({ name, industry: val("industry"), website: val("website"), color });
    setStep((s) => Math.min(2, s + 1));
  };

  return (
    <form ref={form} action={action} onKeyDown={(e) => e.key === "Enter" && step < 2 && (e.target as HTMLElement).tagName === "INPUT" && (e.preventDefault(), next())}>
      {/* Шаги с прогрессом */}
      <ol className="mb-5 flex items-center gap-2">
        {steps.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cx(
                "grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold transition",
                i < step ? "bg-success text-white" : i === step ? "bg-accent text-accent-text" : "bg-surface-2 text-muted",
              )}
            >
              {i < step ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cx("truncate text-sm", i === step ? "font-semibold" : "text-muted")}>{label}</span>
            {i < steps.length - 1 && <span className={cx("h-px flex-1 transition", i < step ? "bg-success" : "bg-border")} />}
          </li>
        ))}
      </ol>

      <Card className="space-y-5 p-6">
        <div className={cx("space-y-5", step !== 0 && "hidden")}>
          <Field label={c.name}>
            <Input name="name" required autoFocus maxLength={200} aria-invalid={error || undefined} onChange={() => setError(false)} />
          </Field>
          {error && <p className="-mt-3 text-sm text-danger">{w.nameRequired}</p>}
          <Field label={c.industry}>
            <Input name="industry" placeholder={c.industryPlaceholder} />
          </Field>
          <Field label={c.website} hint={w.websiteHint}>
            <Input name="website" placeholder="https://" />
          </Field>
        </div>

        <div className={cx("space-y-5", step !== 1 && "hidden")}>
          <Field label={c.description} hint={c.descriptionHint}>
            <Textarea name="description" rows={5} />
          </Field>
          <Field label={c.brandVoice} hint={c.brandVoiceHint}>
            <Textarea name="brandVoice" rows={3} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{c.color}</legend>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((col, i) => (
                <label key={col} className="cursor-pointer">
                  <input type="radio" name="color" value={col} defaultChecked={i === 0} className="peer sr-only" />
                  <span className="block size-8 rounded-full ring-offset-2 ring-offset-surface transition peer-checked:ring-2 peer-checked:ring-text peer-focus-visible:ring-2 peer-focus-visible:ring-accent" style={{ background: col }} />
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className={cx("space-y-5", step !== 2 && "hidden")}>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/50 p-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl text-xl font-semibold text-white" style={{ background: summary.color }}>
              {summary.name.charAt(0).toUpperCase() || "?"}
            </span>
            <div className="min-w-0">
              <div className="truncate font-semibold">{summary.name}</div>
              <div className="truncate text-sm text-muted">{[summary.industry, summary.website].filter(Boolean).join(" · ") || "—"}</div>
            </div>
          </div>
          <p className="text-sm text-muted">{w.logoNote}</p>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">{w.nextTitle}</legend>
            {[
              { v: "agent", icon: Bot, title: w.nextAgent, text: w.nextAgentHint },
              { v: "client", icon: Building2, title: w.nextClient, text: w.nextClientHint },
            ].map(({ v, icon: Icon, title, text }, i) => (
              <label key={v} className="cursor-pointer">
                <input type="radio" name="next" value={v} defaultChecked={i === 0} className="peer sr-only" />
                <span className="flex h-full gap-3 rounded-xl border border-border p-3.5 transition peer-checked:border-accent peer-checked:bg-accent-soft/50 peer-focus-visible:ring-2 peer-focus-visible:ring-accent hover:border-accent/50">
                  <Icon className="mt-0.5 size-5 shrink-0 text-accent" />
                  <span>
                    <span className="block text-sm font-semibold">{title}</span>
                    <span className="block text-xs text-muted">{text}</span>
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          {step > 0 ? (
            <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)}>
              <ArrowLeft className="size-4" />
              {t.common.back}
            </Button>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <Button type="button" onClick={next}>
              {w.next}
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Submit label={t.common.create} />
          )}
        </div>
      </Card>
    </form>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button disabled={pending}>
      {pending ? <Spinner /> : <Check className="size-4" />}
      {label}
    </Button>
  );
}
