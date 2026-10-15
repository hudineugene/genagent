"use client";

import { useActionState, useEffect, useRef } from "react";
import { Check, KeyRound, UserRound } from "lucide-react";
import { changePassword, updateProfile } from "@/app/actions/profile";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";

export function ProfileForms({ name, email }: { name: string; email: string }) {
  const { t } = useI18n();
  const [nameState, nameAction, namePending] = useActionState(updateProfile, undefined);
  const [pwState, pwAction, pwPending] = useActionState(changePassword, undefined);
  const pwForm = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (pwState?.ok) pwForm.current?.reset();
  }, [pwState]);

  const pwError = pwState?.error as keyof typeof t.profile.errors | undefined;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          <UserRound className="size-[18px] text-accent" />
          {t.profile.name}
        </h2>
        <form action={nameAction} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t.profile.name}>
              <Input name="name" defaultValue={name} required maxLength={200} />
            </Field>
            <Field label={t.profile.email}>
              <Input value={email} disabled readOnly />
            </Field>
          </div>
          <div className="flex items-center justify-end gap-3">
            {nameState?.ok && <Saved text={t.profile.nameSaved} />}
            {nameState?.error && <p className="text-sm text-danger">{t.profile.errors.name}</p>}
            <Button variant="secondary" disabled={namePending}>
              {namePending && <Spinner />}
              {t.profile.saveName}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          <KeyRound className="size-[18px] text-accent" />
          {t.profile.passwordTitle}
        </h2>
        <form ref={pwForm} action={pwAction} className="space-y-4">
          <Field label={t.profile.current}>
            <Input name="current" type="password" autoComplete="current-password" required />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t.profile.next} hint={t.profile.minLength}>
              <Input name="next" type="password" autoComplete="new-password" required minLength={8} />
            </Field>
            <Field label={t.profile.confirm}>
              <Input name="confirm" type="password" autoComplete="new-password" required minLength={8} />
            </Field>
          </div>
          <div className="flex items-center justify-end gap-3">
            {pwState?.ok && <Saved text={t.profile.changed} />}
            {pwError && <p className="text-sm text-danger">{t.profile.errors[pwError]}</p>}
            <Button disabled={pwPending}>
              {pwPending && <Spinner />}
              {t.profile.change}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Saved({ text }: { text: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-success">
      <Check className="size-4" />
      {text}
    </span>
  );
}
