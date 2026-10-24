"use client";

import { useActionState } from "react";
import { login, loginCode } from "@/app/actions/auth";
import { useI18n } from "@/lib/i18n/client";
import { LocaleSwitch } from "@/components/sidebar";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";
import { BrandLogo } from "@/components/brand";

export function LoginForm() {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(login, undefined);
  const [codeState, codeAction, codePending] = useActionState(loginCode, undefined);
  const step = state?.step === "code";

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* Фирменная половина: всегда «металл» (тёмная), логотип для тёмного фона, свечение в цветах знака */}
      <section className="relative hidden overflow-hidden bg-[#0b0c0f] text-[#e8ebf0] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="pointer-events-none absolute -top-40 -left-32 size-[34rem] rounded-full bg-[radial-gradient(circle,rgb(255_120_40/0.22),transparent_65%)]" />
        <div aria-hidden className="pointer-events-none absolute -right-40 -bottom-48 size-[38rem] rounded-full bg-[radial-gradient(circle,rgb(122_162_255/0.16),transparent_65%)]" />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,transparent_35%,rgb(255_255_255/0.04)_50%,transparent_65%)]" />
        <div aria-hidden className="pointer-events-none absolute inset-0 [background-image:linear-gradient(rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.035)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
        <BrandLogo width={340} dark className="relative" />
        <div className="relative max-w-md">
          <p className="font-display text-3xl leading-tight font-bold tracking-tight">{t.login.tagline}</p>
          <ul className="mt-6 space-y-3 text-[15px] text-[#aab2c0]">
            {t.login.points.split("|").map((p) => (
              <li key={p} className="flex items-start gap-3">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[#ff7a2f] shadow-[0_0_10px_2px_rgb(255_122_47/0.6)]" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-[#6b7383]">© GenAgent · AI agents platform</p>
      </section>

      <div className="grid place-items-center px-4 py-10">
        <Card className="animate-page-in w-full max-w-sm p-8 shadow-xl shadow-black/5">
          <div className="mb-8 flex items-start justify-between gap-4">
            <BrandLogo width={172} className="lg:hidden" />
            <span className="hidden lg:block" />
            <LocaleSwitch />
          </div>
          <h1 className="text-xl font-bold tracking-tight">{t.login.title}</h1>
          <p className="mb-6 mt-1 text-sm text-muted">{t.login.subtitle}</p>
          {step ? (
            <form action={codeAction} className="space-y-4">
              <Field label={t.login.code} hint={t.login.codeHint}>
                <Input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={20} className="font-mono tracking-widest" />
              </Field>
              {codeState?.error && (
                <p className="text-sm text-danger">
                  {codeState.error === "locked" ? t.login.locked.replace("{n}", String(codeState.minutes ?? 15)) : codeState.error === "code" ? t.login.badCode : t.login.expired}
                </p>
              )}
              <Button className="w-full" disabled={codePending}>
                {codePending && <Spinner />}
                {t.login.submit}
              </Button>
            </form>
          ) : (
          <form action={action} className="space-y-4">
            <Field label={t.login.email}>
              <Input name="email" type="email" autoComplete="username" required autoFocus />
            </Field>
            <Field label={t.login.password}>
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            {state?.error && (
              <p className="text-sm text-danger">
                {state.error === "locked" ? t.login.locked.replace("{n}", String(state.minutes ?? 15)) : t.login.invalid}
              </p>
            )}
            <Button className="w-full" disabled={pending}>
              {pending && <Spinner />}
              {t.login.submit}
            </Button>
          </form>
          )}
        </Card>
      </div>
    </div>
  );
}
