"use client";

import { useFormStatus } from "react-dom";
import type { Client } from "@/db/schema";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Spinner, Textarea } from "./ui";

const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

export function ClientForm({
  action,
  client,
}: {
  action: (formData: FormData) => Promise<void>;
  client?: Client;
}) {
  const { t } = useI18n();
  return (
    <form action={action}>
      <Card className="space-y-5 p-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t.clients.name}>
            <Input name="name" required defaultValue={client?.name} autoFocus={!client} />
          </Field>
          <Field label={t.clients.industry}>
            <Input name="industry" defaultValue={client?.industry} placeholder={t.clients.industryPlaceholder} />
          </Field>
        </div>
        <Field label={t.clients.website}>
          <Input name="website" defaultValue={client?.website} placeholder="https://" />
        </Field>
        <Field label={t.clients.description} hint={t.clients.descriptionHint}>
          <Textarea name="description" rows={5} defaultValue={client?.description} />
        </Field>
        <Field label={t.clients.brandVoice} hint={t.clients.brandVoiceHint}>
          <Textarea name="brandVoice" rows={3} defaultValue={client?.brandVoice} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t.clients.color}</legend>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c, i) => (
              <label key={c} className="cursor-pointer">
                <input
                  type="radio"
                  name="color"
                  value={c}
                  defaultChecked={client ? client.color === c : i === 0}
                  className="peer sr-only"
                />
                <span
                  className="block size-8 rounded-full ring-offset-2 ring-offset-surface transition peer-checked:ring-2 peer-checked:ring-text"
                  style={{ background: c }}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end">
          <SubmitButton label={client ? t.common.save : t.common.create} />
        </div>
      </Card>
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button disabled={pending}>
      {pending && <Spinner />}
      {label}
    </Button>
  );
}
