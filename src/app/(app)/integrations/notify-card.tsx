"use client";

import { useActionState, useState, useTransition } from "react";
import { Bell, Check, Copy, RefreshCw, Send, Trash2, X } from "lucide-react";
import {
  regenerateNotifyLink,
  removeNotifyBot,
  removeNotifySubscriber,
  saveNotifyBot,
  sendNotifyTest,
} from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";
import { ask } from "@/components/confirm-dialog";

export type NotifyView = {
  botUsername: string;
  link: string;
  subscribers: { chatId: string; name: string; since: number }[];
} | null;

/** Уведомления студии в Telegram: бот, ссылка подписки для сотрудников, подписчики. Сводки, проверки и копия базы — на своих вкладках. */
export function NotifyCard({ notify }: { notify: NotifyView }) {
  const { t, locale } = useI18n();
  const s = t.integrations;
  const [state, action, pending] = useActionState(saveNotifyBot, undefined);
  const [busy, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const [tested, setTested] = useState(false);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
          <Bell className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{s.notifyTitle}</div>
          <div className="truncate text-xs text-muted">{notify ? `@${notify.botUsername}` : s.notConfigured}</div>
        </div>
        {notify && (
          <Button
            variant="ghost"
            size="sm"
            className="hover:text-danger"
            title={s.googleRemove}
            disabled={busy}
            onClick={async () => {
              if (await ask(s.notifyRemoveConfirm)) start(async () => void (await removeNotifyBot()));
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">{s.notifyHint}</p>

      {!notify ? (
        <form action={action} className="space-y-3">
          <Field label={s.notifyToken} hint={s.notifyTokenHint}>
            <Input name="token" required autoComplete="off" spellCheck={false} placeholder="123456789:AAH…" className="font-mono" />
          </Field>
          <div className="flex items-center justify-end gap-3">
            {state?.error && <p className="text-sm text-danger">{s.errors[state.error as keyof typeof s.errors] ?? state.error}</p>}
            <Button disabled={pending}>
              {pending ? <Spinner /> : <Send className="size-4" />}
              {s.notifyConnect}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">{s.notifyLink}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title={s.notifyNewLink}
                onClick={async () => {
                  if (await ask(s.notifyNewLinkConfirm)) start(async () => void (await regenerateNotifyLink()));
                }}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
            <div className="flex items-stretch gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs">{notify.link}</code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-auto"
                onClick={async () => {
                  await navigator.clipboard.writeText(notify.link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted">{s.notifyLinkHint}</p>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-muted">
              {s.notifySubscribers}: {notify.subscribers.length}
            </div>
            {notify.subscribers.length === 0 ? (
              <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">{s.notifyNobody}</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {notify.subscribers.map((sub) => (
                  <li key={sub.chatId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                    <span className="text-xs text-muted">{Number.isFinite(new Date(sub.since).getTime()) ? fmt.format(new Date(sub.since)) : "—"}</span>
                    <button
                      type="button"
                      className="rounded-lg p-1 text-muted hover:text-danger"
                      aria-label={t.common.delete}
                      disabled={busy}
                      onClick={() => start(async () => void (await removeNotifySubscriber(sub.chatId)))}
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-end gap-3">
            {tested && (
              <span className="flex items-center gap-1.5 text-sm text-success">
                <Check className="size-4" />
                {s.notifySent}
              </span>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={busy || notify.subscribers.length === 0}
              onClick={() =>
                start(async () => {
                  await sendNotifyTest();
                  setTested(true);
                  setTimeout(() => setTested(false), 3000);
                })
              }
            >
              {busy ? <Spinner /> : <Send className="size-4" />}
              {s.notifyTest}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
