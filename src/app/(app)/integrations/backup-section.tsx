"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, DatabaseBackup, Send } from "lucide-react";
import { saveOffsiteBackup, sendOffsiteBackupNow } from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Button, Field, Input, Select, Spinner } from "@/components/ui";

export type OffsiteView = { enabled: boolean; chatId: string; hasPassword: boolean; lastSentAt: string | null; lastError: string | null } | null;

/** Копия базы в Telegram: кому, пароль шифрования, включение, «Отправить сейчас». */
export function BackupSection({ offsite, subscribers }: { offsite: OffsiteView; subscribers: { chatId: string; name: string }[] }) {
  const { t, locale } = useI18n();
  const s = t.integrations;
  const [state, action, pending] = useActionState(saveOffsiteBackup, undefined);
  const [sending, start] = useTransition();
  const [sendResult, setSendResult] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium", timeStyle: "short" });
  const errText = (code?: string) => (code ? (s.errors[code as keyof typeof s.errors] ?? code) : null);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2 font-medium">
        <DatabaseBackup className="size-4 text-accent" />
        {s.backupTitle}
      </div>
      <p className="text-sm text-muted">{s.backupHint}</p>
      <form action={action} className="space-y-3" key={JSON.stringify(offsite)}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={s.backupRecipient}>
            <Select name="chatId" defaultValue={offsite?.chatId ?? subscribers[0]?.chatId}>
              {subscribers.map((sub) => (
                <option key={sub.chatId} value={sub.chatId}>
                  {sub.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={s.backupPassword} hint={offsite?.hasPassword ? s.backupPasswordKept : s.backupPasswordHint}>
            <Input name="password" type="password" autoComplete="new-password" placeholder={offsite?.hasPassword ? "••••••••••" : ""} />
          </Field>
          <Field label={s.backupConfirm}>
            <Input name="confirm" type="password" autoComplete="new-password" />
          </Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={offsite?.enabled ?? false} className="size-4 accent-[var(--accent)]" />
          {s.backupEnabled}
        </label>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {state?.ok && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <Check className="size-4" />
              {t.common.saved}
            </span>
          )}
          {state?.error && <p className="text-sm text-danger">{errText(state.error)}</p>}
          <Button variant="secondary" disabled={pending}>
            {pending && <Spinner />}
            {t.common.save}
          </Button>
        </div>
      </form>
      {offsite?.enabled && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
          <span>
            {offsite.lastSentAt ? `${s.backupLastSent}: ${fmt.format(new Date(offsite.lastSentAt))}` : s.backupNeverSent}
            {offsite.lastError && <span className="ml-2 text-danger">· {offsite.lastError}</span>}
          </span>
          <span className="flex items-center gap-2">
            {sendResult && <span className={sendResult === "ok" ? "text-success" : "text-danger"}>{sendResult === "ok" ? s.backupSent : errText(sendResult)}</span>}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={sending}
              onClick={() =>
                start(async () => {
                  const r = await sendOffsiteBackupNow();
                  setSendResult(r.ok ? "ok" : (r.error ?? "backup_failed"));
                })
              }
            >
              {sending ? <Spinner /> : <Send className="size-4" />}
              {s.backupSendNow}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
