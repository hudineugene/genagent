"use client";

import { useActionState, useState, useTransition } from "react";
import { AlertTriangle, AtSign, CalendarDays, Camera, Check, Copy } from "lucide-react";
import { removeGoogleKey, saveGoogleKey, saveMetaSettings, type IntegrationsResult } from "@/app/actions/integrations";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Spinner, Textarea } from "@/components/ui";

type App = { appId: string; hasSecret: boolean } | null;
type Urls = {
  instagramRedirect: string;
  threadsRedirect: string;
  instagramWebhook: string;
  threadsWebhook: string;
  deauthorize: string;
  dataDeletion: string;
};

export function IntegrationsForm({
  instagram,
  threads,
  verifyToken,
  urls,
}: {
  instagram: App;
  threads: App;
  verifyToken: string;
  urls: Urls | null;
}) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(saveMetaSettings, undefined);
  const s = t.integrations;

  return (
    <div className="space-y-6">
      {!urls && (
        <div className="flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          {s.noPublicUrl}
        </div>
      )}

      <form action={action} className="space-y-6">
        <AppCard
          icon={<Camera className="size-5" />}
          title="Instagram"
          hint={s.instagramHint}
          prefix="instagram"
          app={instagram}
          urls={urls ? [[s.redirectUrl, urls.instagramRedirect], [s.webhookUrl, urls.instagramWebhook]] : []}
        />
        <AppCard
          icon={<AtSign className="size-5" />}
          title="Threads"
          hint={s.threadsHint}
          prefix="threads"
          app={threads}
          urls={urls ? [[s.redirectUrl, urls.threadsRedirect], [s.webhookUrl, urls.threadsWebhook]] : []}
        />
        <div className="flex items-center justify-end gap-3">
          {state?.ok && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <Check className="size-4" />
              {t.common.saved}
            </span>
          )}
          {state?.error && <p className="text-sm text-danger">{s.errors[state.error as keyof typeof s.errors]}</p>}
          <Button disabled={pending}>
            {pending && <Spinner />}
            {t.common.save}
          </Button>
        </div>
      </form>

      <Card className="space-y-3 p-5">
        <div className="font-semibold">{s.commonTitle}</div>
        <CopyRow label={s.verifyToken} value={verifyToken} />
        {urls && (
          <>
            <CopyRow label={s.deauthorizeUrl} value={urls.deauthorize} />
            <CopyRow label={s.dataDeletionUrl} value={urls.dataDeletion} />
          </>
        )}
        <p className="text-xs text-muted">{s.commonHint}</p>
      </Card>
    </div>
  );
}

function AppCard({
  icon,
  title,
  hint,
  prefix,
  app,
  urls,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  prefix: "instagram" | "threads";
  app: App;
  urls: [string, string][];
}) {
  const { t } = useI18n();
  const s = t.integrations;
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</span>
        <div>
          <div className="font-semibold">{title}</div>
          <div className="text-xs text-muted">{app ? s.connected : s.notConfigured}</div>
        </div>
      </div>
      <p className="text-sm text-muted">{hint}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={s.appId}>
          <Input name={`${prefix}AppId`} defaultValue={app?.appId} inputMode="numeric" autoComplete="off" />
        </Field>
        <Field label={s.appSecret} hint={app?.hasSecret ? s.secretKept : undefined}>
          <Input
            name={`${prefix}AppSecret`}
            type="password"
            autoComplete="new-password"
            placeholder={app?.hasSecret ? "••••••••••••" : ""}
          />
        </Field>
      </div>
      {urls.map(([label, value]) => (
        <CopyRow key={label} label={label} value={value} />
      ))}
    </Card>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl bg-surface-2 px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-auto"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title={t.channels.copy}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

export function GoogleCard({ email }: { email: string | null }) {
  const { t } = useI18n();
  const s = t.integrations;
  const [state, setState] = useState<IntegrationsResult>();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(!email);
  const [removing, setRemoving] = useState(false);
  const showForm = editing || !email;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
          <CalendarDays className="size-5" />
        </span>
        <div>
          <div className="font-semibold">{s.googleTitle}</div>
          <div className="text-xs text-muted">{email ? s.connected : s.notConfigured}</div>
        </div>
      </div>
      {email && (
        <>
          <CopyRow label={s.googleEmail} value={email} />
          <p className="text-sm text-muted">{s.googleShare}</p>
        </>
      )}
      {showForm ? (
        <form
          // onSubmit, а не action: при ошибке вставленный ключ остаётся в поле
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => {
              const r = await saveGoogleKey(undefined, fd);
              setState(r);
              if (r.ok) setEditing(false);
            });
          }}
          className="space-y-3"
        >
          <p className="text-sm text-muted">{s.googleHint}</p>
          <Field label={s.googleKey}>
            <Textarea
              name="key"
              rows={5}
              required
              spellCheck={false}
              autoComplete="off"
              placeholder={s.googleKeyPlaceholder}
              className="font-mono text-xs"
            />
          </Field>
          {state?.error && <p className="text-sm text-danger">{s.errors[state.error as keyof typeof s.errors]}</p>}
          <div className="flex items-center justify-end gap-3">
            {email && (
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                {t.common.cancel}
              </Button>
            )}
            <Button disabled={pending}>
              {pending && <Spinner />}
              {t.common.save}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-end gap-3">
          {state?.ok && (
            <span className="flex items-center gap-1.5 text-sm text-success">
              <Check className="size-4" />
              {t.common.saved}
            </span>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              await removeGoogleKey();
              setRemoving(false);
              setState(undefined);
              setEditing(true);
            }}
          >
            {removing && <Spinner />}
            {s.googleRemove}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            {s.googleReplace}
          </Button>
        </div>
      )}
    </Card>
  );
}
