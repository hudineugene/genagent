"use client";

import { useActionState } from "react";
import { Check } from "lucide-react";
import { updateTextSource } from "@/app/actions/kb";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Spinner, Textarea } from "@/components/ui";

export function TextSourceEditor({ id, title, content }: { id: string; title: string; content: string }) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(updateTextSource.bind(null, id), undefined);
  return (
    <form action={action}>
      <Card className="space-y-4 p-5">
        <Field label={t.kb.textTitle}>
          <Input name="title" defaultValue={title} required maxLength={300} />
        </Field>
        <Field label={t.kb.textContent}>
          <Textarea name="content" defaultValue={content} rows={20} required className="font-mono text-[13px]" />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {state?.id && !pending && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <Check className="size-4" />
              {t.common.saved}
            </span>
          )}
          {state?.error && <p className="text-sm text-danger">{t.kb.errors[state.error as keyof typeof t.kb.errors]}</p>}
          <Button disabled={pending}>
            {pending && <Spinner />}
            {t.common.save}
          </Button>
        </div>
      </Card>
    </form>
  );
}
