"use client";

import { useActionState } from "react";
import { Sparkles } from "lucide-react";
import { login } from "@/app/actions/auth";
import { useI18n } from "@/lib/i18n/client";
import { LocaleSwitch } from "@/components/sidebar";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";

export function LoginForm() {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <Card className="w-full max-w-sm p-8 shadow-xl shadow-black/5">
      <div className="mb-8 flex items-start justify-between">
        <span className="grid size-11 place-items-center rounded-2xl bg-accent text-accent-text">
          <Sparkles className="size-6" />
        </span>
        <LocaleSwitch />
      </div>
      <h1 className="text-xl font-semibold">{t.login.title}</h1>
      <p className="mb-6 mt-1 text-sm text-muted">{t.login.subtitle}</p>
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
    </Card>
  );
}
