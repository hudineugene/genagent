"use client";

import { useActionState, useEffect, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, AtSign, Bot, Camera, Check, Copy, ExternalLink, Eye, Globe, Mail, MessageCircle, Plus, Power, RefreshCw, Send, Trash2 } from "lucide-react";
import {
  addApiChannel,
  addEmailChannel,
  addTelegramChannel,
  addWidgetChannel,
  deleteChannel,
  regenerateApiKey,
  setChannelEnabled,
  startSocialConnect,
  updateEmailChannel,
  updateApiChannel,
  updateSocialChannel,
  updateTelegramChannel,
  updateWidget, addWhatsAppChannel } from "@/app/actions/channels";
import { WIDGET_LANGS, type ChannelType, type WidgetConfig } from "@/db/schema";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Spinner, Textarea, cx } from "@/components/ui";
import { InfoHint } from "@/components/hint";

export type ChannelItem = {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  error: string | null;
  live: boolean;
  /** Последнее сообщение клиента и последнее уведомление Meta (мс) — видно, доходят ли сообщения */
  lastInboundAt: number | null;
  webhookAt: number | null;
  /** Неделю (или ни разу) без сообщений клиентов */
  inboundStale: boolean;
  username: string | null;
  widget: WidgetConfig | null;
  whatsapp: { phone: string; name: string } | null;
  social: { dm?: boolean; comments?: boolean; approval: boolean; tokenExpiresAt: number } | null;
  email: { address: string; approval: boolean; fromName: string } | null;
  api: { key: string; label: string; approval: boolean; botNote: string; followUps: boolean; orderNotes: boolean } | null;
  telegram: { comments: boolean; approval: boolean; group: { id: number; title: string; channel?: string } | null } | null;
};

type SocialReady = { publicUrl: boolean; instagram: boolean; threads: boolean; whatsapp: boolean };

type ErrKey = keyof ReturnType<typeof useI18n>["t"]["channels"]["errors"];

export function ChannelsManager({
  agentId,
  agentStatus,
  channels,
  publicUrl,
  socialReady,
  isAdmin,
}: {
  agentId: string;
  agentStatus: "draft" | "active" | "paused";
  channels: ChannelItem[];
  publicUrl: string | null;
  socialReady: SocialReady;
  isAdmin: boolean;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState<"telegram" | "instagram" | "threads" | "email" | "api" | "whatsapp" | null>(null);
  const [pending, start] = useTransition();
  const errText = (code: string | null | undefined) =>
    code ? (t.channels.errors[code as ErrKey] ?? code) : null;

  return (
    <div className="space-y-6">
      {agentStatus !== "active" && (
        <div className="flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>{t.channels.agentInactive.replace("{status}", t.status[agentStatus])}</span>
        </div>
      )}

      {channels.map((c) =>
        c.type === "telegram" ? (
          <TelegramCard key={c.id} c={c} errText={errText} />
        ) : c.type === "widget" ? (
          <WidgetCard key={c.id} c={c} publicUrl={publicUrl} />
        ) : c.type === "email" ? (
          <EmailCard key={c.id} c={c} errText={errText} />
        ) : c.type === "api" ? (
          <ApiCard key={c.id} c={c} publicUrl={publicUrl} />
        ) : c.type === "whatsapp" ? (
          <WhatsAppCard key={c.id} c={c} />
        ) : (
          <SocialCard key={c.id} c={c} agentId={agentId} errText={errText} />
        ),
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t.channels.add}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AddCard
            icon={<Send className="size-5" />}
            title={t.channels.telegram}
            desc={t.channels.telegramDesc}
            active={adding === "telegram"}
            onClick={() => setAdding(adding === "telegram" ? null : "telegram")}
          />
          <AddCard
            icon={pending ? <Spinner /> : <Globe className="size-5" />}
            title={t.channels.widget}
            desc={t.channels.widgetDesc}
            onClick={() => start(async () => void (await addWidgetChannel(agentId)))}
          />
          <AddCard
            icon={<Camera className="size-5" />}
            title="Instagram"
            desc={t.channels.instagramDesc}
            active={adding === "instagram"}
            onClick={() => setAdding(adding === "instagram" ? null : "instagram")}
          />
          <AddCard
            icon={<AtSign className="size-5" />}
            title="Threads"
            desc={t.channels.threadsDesc}
            active={adding === "threads"}
            onClick={() => setAdding(adding === "threads" ? null : "threads")}
          />
          <AddCard
            icon={<Mail className="size-5" />}
            title={t.channels.email}
            desc={t.channels.emailDesc}
            active={adding === "email"}
            onClick={() => setAdding(adding === "email" ? null : "email")}
          />
          <AddCard
            icon={<MessageCircle className="size-5" />}
            title="WhatsApp Business"
            desc={socialReady.whatsapp ? t.channels.whatsappDesc : t.channels.whatsappSoon}
            active={adding === "whatsapp"}
            onClick={() => setAdding(adding === "whatsapp" ? null : "whatsapp")}
          />
          <AddCard
            icon={<Bot className="size-5" />}
            title={t.channels.api}
            desc={t.channels.apiDesc}
            active={adding === "api"}
            onClick={() => setAdding(adding === "api" ? null : "api")}
          />
        </div>
        {adding === "api" && <ApiForm agentId={agentId} onDone={() => setAdding(null)} />}
        {adding === "whatsapp" && <WhatsAppForm agentId={agentId} ready={socialReady.whatsapp && socialReady.publicUrl} onDone={() => setAdding(null)} />}
        {adding === "email" && <EmailForm agentId={agentId} onDone={() => setAdding(null)} errText={errText} />}
        {adding === "telegram" && <TelegramForm agentId={agentId} onDone={() => setAdding(null)} errText={errText} />}
        {(adding === "instagram" || adding === "threads") && (
          <Card className="mt-3 p-5">
            <SocialConnect agentId={agentId} provider={adding} ready={socialReady} isAdmin={isAdmin} />
          </Card>
        )}
      </div>
    </div>
  );
}

function AddCard({
  icon,
  title,
  desc,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex items-start gap-3 rounded-2xl border bg-surface p-4 text-left transition hover:border-accent/50",
        active ? "border-accent" : "border-dashed border-border",
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</span>
      <span>
        <span className="flex items-center gap-1.5 font-semibold">
          <Plus className="size-4" />
          {title}
        </span>
        <span className="text-sm text-muted">{desc}</span>
      </span>
    </button>
  );
}

function TelegramForm({
  agentId,
  onDone,
  errText,
}: {
  agentId: string;
  onDone: () => void;
  errText: (c: string | null | undefined) => string | null;
}) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(addTelegramChannel.bind(null, agentId), undefined);
  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);
  return (
    <Card className="mt-3 p-5">
      <form action={action} className="space-y-4">
        <Field label={t.channels.tokenLabel} hint={t.channels.tokenHint}>
          <Input name="token" required autoComplete="off" spellCheck={false} placeholder="123456789:AAH…" className="font-mono" />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {state?.error && <p className="text-sm text-danger">{errText(state.error)}</p>}
          <Button disabled={pending}>
            {pending ? <Spinner /> : <Send className="size-4" />}
            {t.channels.connect}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** «Последнее сообщение: 15 окт., 18:35» (или «ещё не было») — и для Meta: когда пришло последнее уведомление. */
function LastActivity({ c }: { c: ChannelItem }) {
  const { t, locale } = useI18n();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
  const stale = c.inboundStale;
  const meta = c.type === "instagram" || c.type === "threads" || c.type === "whatsapp";
  return (
    <span className={cx("text-xs", stale ? "text-amber-600 dark:text-amber-400" : "text-muted")} title={meta ? t.channels.webhookHint : undefined}>
      {c.lastInboundAt ? `${t.channels.lastInbound}: ${fmt.format(c.lastInboundAt)}` : t.channels.noInbound}
      {meta && ` · ${c.webhookAt ? `${t.channels.lastWebhook}: ${fmt.format(c.webhookAt)}` : t.channels.noWebhook}`}
    </span>
  );
}

function ChannelHeader({ c, icon, title }: { c: ChannelItem; icon: React.ReactNode; title: React.ReactNode }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 font-semibold">{title}</div>
        <Badge tone={c.enabled ? (c.error ? "warning" : "success") : "neutral"}>
          {c.enabled ? (c.type === "telegram" && c.live && !c.error ? t.channels.polling : t.channels.enabled) : t.channels.disabled}
        </Badge>
        {c.enabled && <LastActivity c={c} />}
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        title={c.enabled ? t.channels.disable : t.channels.enable}
        onClick={() => start(async () => void (await setChannelEnabled(c.id, !c.enabled)))}
      >
        {pending ? <Spinner /> : <Power className="size-4" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="hover:text-danger"
        disabled={pending}
        title={t.common.delete}
        onClick={() => {
          if (confirm(t.common.confirmDelete)) start(async () => void (await deleteChannel(c.id)));
        }}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function TelegramCard({ c, errText }: { c: ChannelItem; errText: (c: string | null | undefined) => string | null }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [pending, start] = useTransition();
  const tg = c.telegram;
  const set = (patch: { comments?: boolean; approval?: boolean }) =>
    start(async () => void (await updateTelegramChannel(c.id, patch)));
  return (
    <Card className="space-y-3 p-5">
      <ChannelHeader
        c={c}
        icon={<Send className="size-5" />}
        title={
          <span>
            {t.channels.telegram} <span className="font-normal text-muted">{c.name}</span>
          </span>
        }
      />
      {c.error && <p className="text-sm text-danger">{errText(c.error)}</p>}
      {tg && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Toggle label={ch.tgComments} hint={ch.tgCommentsHint} checked={tg.comments} disabled={pending} onChange={(v) => set({ comments: v })} />
          {tg.comments && (
            <Toggle label={ch.approval} hint={ch.approvalHint} checked={tg.approval} disabled={pending} onChange={(v) => set({ approval: v })} />
          )}
        </div>
      )}
      {tg?.comments && (
        <p className="text-sm text-muted">
          {tg.group
            ? ch.tgGroup.replace("{title}", tg.group.title).replace("{channel}", tg.group.channel ? ` (@${tg.group.channel})` : "")
            : ch.tgCommentsHow.replace("{bot}", c.name)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span>{t.channels.localNote}</span>
        {c.username && (
          <a
            href={`https://t.me/${c.username}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-accent hover:underline"
          >
            {t.channels.openBot}
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </Card>
  );
}

const noopSubscribe = () => () => {};

const COLORS = ["#5b5bf0", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#111827"];

function WidgetCard({ c, publicUrl }: { c: ChannelItem; publicUrl: string | null }) {
  const { t } = useI18n();
  const [state, action, pending] = useActionState(updateWidget.bind(null, c.id), undefined);
  const [copied, setCopied] = useState(false);
  // Адрес для кода вставки: PUBLIC_URL из настроек или адрес, по которому открыта программа.
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => publicUrl ?? window.location.origin,
    () => publicUrl ?? "",
  );
  const w = c.widget!;
  const code = `<script src="${origin}/widget.js" data-channel="${c.id}" async></script>`;
  const local = /localhost|127\.0\.0\.1/.test(origin);

  return (
    <Card className="space-y-5 p-5">
      <ChannelHeader c={c} icon={<Globe className="size-5" />} title={t.channels.widget} />

      <form action={action} className="space-y-4" key={JSON.stringify(w)}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t.channels.title}>
            <Input name="title" defaultValue={w.title} required maxLength={80} />
          </Field>
          <Field label={t.channels.subtitleLabel}>
            <Input name="subtitle" defaultValue={w.subtitle} maxLength={120} placeholder={t.channels.subtitlePlaceholder} />
          </Field>
          <Field label={t.channels.widgetTelegram} hint={t.channels.widgetTelegramHint}>
            <Input name="telegramBot" defaultValue={w.telegramBot ?? ""} maxLength={33} placeholder="@yourbot" />
          </Field>
          <Field label={t.channels.widgetQuick} hint={t.channels.widgetQuickHint}>
            <Textarea name="quick" rows={2} defaultValue={(w.quick ?? []).join("\n")} placeholder={t.channels.widgetQuickPlaceholder} />
          </Field>
          <Field label={t.channels.widgetTeaser} hint={t.channels.widgetTeaserHint}>
            <Input name="teaser" defaultValue={w.teaser ?? ""} maxLength={140} placeholder={t.channels.widgetTeaserPlaceholder} />
          </Field>
          <Field label={t.channels.widgetTeaserDelay}>
            <Input name="teaserDelay" type="number" min={3} max={300} defaultValue={w.teaserDelay ?? 20} />
          </Field>
        </div>
        <details className="rounded-xl border border-border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium select-none">
            {t.channels.widgetLocales}
            <span className="ml-2 text-xs font-normal text-muted">{t.channels.widgetLocalesHint}</span>
          </summary>
          <div className="mt-3 space-y-4">
            {WIDGET_LANGS.map((lang) => {
              const loc = w.locales?.[lang] ?? {};
              return (
                <div key={lang} className="grid grid-cols-1 gap-2 sm:grid-cols-[3rem_1fr_1fr]">
                  <span className="pt-2 text-xs font-semibold text-muted uppercase">{lang}</span>
                  <Input name={`l_${lang}_title`} defaultValue={loc.title ?? ""} maxLength={80} placeholder={t.channels.title} />
                  <Input name={`l_${lang}_subtitle`} defaultValue={loc.subtitle ?? ""} maxLength={120} placeholder={t.channels.subtitleLabel} />
                  <span className="hidden sm:block" />
                  <Textarea name={`l_${lang}_greeting`} rows={2} defaultValue={loc.greeting ?? ""} maxLength={1000} placeholder={t.channels.widgetGreeting} />
                  <Textarea name={`l_${lang}_quick`} rows={2} defaultValue={(loc.quick ?? []).join("\n")} placeholder={t.channels.widgetQuick} />
                  <span className="hidden sm:block" />
                  <Input name={`l_${lang}_teaser`} defaultValue={loc.teaser ?? ""} maxLength={140} placeholder={t.channels.widgetTeaser} className="sm:col-span-2" />
                </div>
              );
            })}
          </div>
        </details>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t.channels.color}</legend>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((col) => (
                <label key={col} className="cursor-pointer">
                  <input type="radio" name="color" value={col} defaultChecked={w.color === col} className="peer sr-only" />
                  <span
                    className="block size-7 rounded-full ring-offset-2 ring-offset-surface peer-checked:ring-2 peer-checked:ring-text"
                    style={{ background: col }}
                  />
                </label>
              ))}
              {!COLORS.includes(w.color) && (
                <label className="cursor-pointer">
                  <input type="radio" name="color" value={w.color} defaultChecked className="peer sr-only" />
                  <span
                    className="block size-7 rounded-full ring-offset-2 ring-offset-surface peer-checked:ring-2 peer-checked:ring-text"
                    style={{ background: w.color }}
                  />
                </label>
              )}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t.channels.position}</legend>
            <div className="flex gap-4 text-sm">
              {(["right", "left"] as const).map((p) => (
                <label key={p} className="flex cursor-pointer items-center gap-2">
                  <input type="radio" name="position" value={p} defaultChecked={w.position === p} className="accent-[var(--accent)]" />
                  {t.channels[p]}
                </label>
              ))}
            </div>
          </fieldset>
          <Button variant="secondary" disabled={pending}>
            {pending ? <Spinner /> : state?.ok ? <Check className="size-4" /> : null}
            {t.common.save}
          </Button>
        </div>
      </form>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium">{t.channels.embed}</span>
          <a
            href={`/w/${c.id}/demo`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-sm text-accent hover:underline"
          >
            {t.channels.preview}
            <ExternalLink className="size-3.5" />
          </a>
        </div>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-xs">
            {code}
          </code>
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            <span className="hidden sm:inline">{copied ? t.channels.copied : t.channels.copy}</span>
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted">{t.channels.embedHint}</p>
        {local && (
          <p className="mt-3 flex gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            {t.channels.localhostWarning}
          </p>
        )}
      </div>
    </Card>
  );
}

const noopSubscribeSocial = () => () => {};

/** Вход в Instagram/Threads: открыть самому или переслать ссылку клиенту (действует сутки). */
function SocialConnect({
  agentId,
  provider,
  ready,
  isAdmin,
  compact,
}: {
  agentId: string;
  provider: "instagram" | "threads";
  ready: SocialReady;
  isAdmin: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const c = t.channels;

  if (!ready.publicUrl || !ready[provider]) {
    return (
      <div className="flex gap-2 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          {!ready.publicUrl ? c.socialNoPublicUrl : c.socialNotConfigured}{" "}
          {isAdmin && ready.publicUrl && (
            <Link href="/integrations?tab=social" className="text-accent hover:underline">
              {t.nav.integrations} →
            </Link>
          )}
        </span>
      </div>
    );
  }

  const get = () =>
    start(async () => {
      setError(null);
      const r = await startSocialConnect(agentId, provider);
      if (r.url) setUrl(r.url);
      else setError(r.error ?? "error");
    });

  return (
    <div className="space-y-3">
      {!compact && <p className="text-sm text-muted">{provider === "instagram" ? c.instagramHow : c.threadsHow}</p>}
      {!url ? (
        <Button
          type="button"
          variant={compact ? "secondary" : "primary"}
          size={compact ? "sm" : "md"}
          disabled={pending}
          onClick={get}
        >
          {pending ? <Spinner /> : compact ? <RefreshCw className="size-4" /> : <Plus className="size-4" />}
          {compact ? c.reconnect : c.getLink}
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-text"
            >
              <ExternalLink className="size-4" />
              {c.loginNow}
            </a>
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? c.copied : c.copyForClient}
            </Button>
          </div>
          <p className="text-xs text-muted">{c.linkHint}</p>
        </div>
      )}
      {error && <p className="text-sm text-danger">{c.errors[error as ErrKey] ?? error}</p>}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cx("flex items-center gap-3 py-1.5", disabled && "opacity-60")}>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        {label}
        {hint && <InfoHint>{hint}</InfoHint>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-accent" : "bg-border")}
      >
        <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </button>
    </div>
  );
}

function SocialCard({
  c,
  agentId,
  errText,
}: {
  c: ChannelItem;
  agentId: string;
  errText: (c: string | null | undefined) => string | null;
}) {
  const { t, locale } = useI18n();
  const [pending, start] = useTransition();
  const s = c.social!;
  const ch = t.channels;
  // «Сейчас» с точностью до минуты: на сервере 0, в браузере — реальное время (без расхождения при гидратации).
  const now = useSyncExternalStore(noopSubscribeSocial, () => Math.floor(Date.now() / 60000) * 60000, () => 0);
  const days = now ? Math.round((s.tokenExpiresAt - now) / 86400000) : null;
  const set = (patch: { dm?: boolean; comments?: boolean; approval?: boolean }) =>
    start(async () => void (await updateSocialChannel(c.id, patch)));
  const isIg = c.type === "instagram";
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });

  return (
    <Card className="space-y-4 p-5">
      <ChannelHeader
        c={c}
        icon={isIg ? <Camera className="size-5" /> : <AtSign className="size-5" />}
        title={
          <span className="block min-w-0">
            {isIg ? "Instagram" : "Threads"}
            <span className="block truncate text-sm font-normal text-muted">{c.name}</span>
          </span>
        }
      />
      {c.error && <p className="text-sm text-danger">{errText(c.error)}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {isIg && (
          <Toggle label={ch.igDm} hint={ch.igDmHint} checked={Boolean(s.dm)} disabled={pending} onChange={(v) => set({ dm: v })} />
        )}
        {isIg && (
          <Toggle
            label={ch.igComments}
            hint={ch.igCommentsHint}
            checked={Boolean(s.comments)}
            disabled={pending}
            onChange={(v) => set({ comments: v })}
          />
        )}
        {!isIg && <Toggle label={ch.threadsReplies} hint={ch.threadsRepliesHint} checked disabled onChange={() => {}} />}
        <Toggle label={ch.approval} hint={ch.approvalHint} checked={s.approval} disabled={pending} onChange={(v) => set({ approval: v })} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span className={cx(days !== null && days < 7 && "text-danger")}>
          {ch.tokenUntil} {s.tokenExpiresAt ? fmt.format(new Date(s.tokenExpiresAt)) : "—"}
          {days !== null && ` (${days} ${ch.days})`} · {ch.tokenAuto}
        </span>
        <SocialConnect
          agentId={agentId}
          provider={c.type as "instagram" | "threads"}
          ready={{ publicUrl: true, instagram: true, threads: true, whatsapp: true }}
          isAdmin={false}
          compact
        />
      </div>
    </Card>
  );
}

function EmailForm({
  agentId,
  onDone,
  errText,
}: {
  agentId: string;
  onDone: () => void;
  errText: (c: string | null | undefined) => string | null;
}) {
  const { t } = useI18n();
  const ch = t.channels;
  const [state, action, pending] = useActionState(addEmailChannel.bind(null, agentId), undefined);
  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);
  return (
    <Card className="mt-3 p-5">
      <form action={action} className="space-y-4">
        <p className="text-sm text-muted">{ch.emailHow}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={ch.emailAddress}>
            <Input name="address" type="email" required autoComplete="off" placeholder="name@gmail.com" />
          </Field>
          <Field label={ch.emailPassword} hint={ch.emailPasswordHint}>
            <Input name="password" type="password" required autoComplete="new-password" spellCheck={false} placeholder="xxxx xxxx xxxx xxxx" className="font-mono" />
          </Field>
        </div>
        <Field label={ch.emailFromName} hint={ch.emailFromNameHint}>
          <Input name="fromName" maxLength={80} />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {state?.error && <p className="text-sm text-danger">{errText(state.error)}</p>}
          <Button disabled={pending}>
            {pending ? <Spinner /> : <Mail className="size-4" />}
            {pending ? ch.emailChecking : ch.emailConnect}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EmailCard({ c, errText }: { c: ChannelItem; errText: (c: string | null | undefined) => string | null }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [pending, start] = useTransition();
  const e = c.email!;
  return (
    <Card className="space-y-4 p-5">
      <ChannelHeader
        c={c}
        icon={<Mail className="size-5" />}
        title={
          <span className="block min-w-0">
            {ch.email}
            <span className="block truncate text-sm font-normal text-muted">{e.address}</span>
          </span>
        }
      />
      {c.error && <p className="text-sm text-danger">{errText(c.error)}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Toggle
          label={ch.emailApproval}
          hint={ch.emailApprovalHint}
          checked={e.approval}
          disabled={pending}
          onChange={(v) => start(async () => void (await updateEmailChannel(c.id, { approval: v })))}
        />
        <div className="rounded-xl border border-border p-3 text-xs text-muted">
          <span className="block text-sm font-medium text-text">{ch.emailFromName}</span>
          {e.fromName} &lt;{e.address}&gt;
        </div>
      </div>
      <p className="text-xs text-muted">{ch.emailNote}</p>
    </Card>
  );
}

/** WhatsApp Business: ID номера и постоянный токен из кабинета Meta. Пока нет приложения Meta — только объяснение. */
function WhatsAppForm({ agentId, ready, onDone }: { agentId: string; ready: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [phoneId, setPhoneId] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!ready) {
    return (
      <Card className="mt-3 space-y-2 p-5 text-sm">
        <p className="font-medium">{ch.whatsappSoon}</p>
        <p className="text-muted">{ch.whatsappSteps}</p>
      </Card>
    );
  }
  return (
    <Card className="mt-3 p-5">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await addWhatsAppChannel(agentId, phoneId, token);
            if (r.ok) onDone();
            else setError(r.error ?? "error");
          });
        }}
      >
        <p className="text-sm text-muted">{ch.whatsappHow}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={ch.whatsappPhoneId}>
            <Input value={phoneId} onChange={(e) => setPhoneId(e.target.value)} inputMode="numeric" required />
          </Field>
          <Field label={ch.whatsappToken}>
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="new-password" required />
          </Field>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end">
          <Button disabled={pending || !phoneId.trim() || !token.trim()}>
            {pending ? <Spinner /> : <Plus className="size-4" />}
            {ch.whatsappConnect}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function WhatsAppCard({ c }: { c: ChannelItem }) {
  const { t } = useI18n();
  return (
    <Card className="space-y-3 p-5">
      <ChannelHeader c={c} icon={<MessageCircle className="size-5" />} title={`WhatsApp · ${c.whatsapp?.phone ?? c.name}`} />
      {c.whatsapp?.name && <p className="text-sm text-muted">{c.whatsapp.name}</p>}
      <p className="text-xs text-muted">{t.channels.whatsappNote}</p>
    </Card>
  );
}

function ApiForm({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [label, setLabel] = useState("");
  const [pending, start] = useTransition();
  return (
    <Card className="mt-3 p-5">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await addApiChannel(agentId, label);
            if (r.ok) onDone();
          });
        }}
      >
        <p className="text-sm text-muted">{ch.apiHow}</p>
        <Field label={ch.apiLabel}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} placeholder="@my_company_bot" />
        </Field>
        <div className="flex justify-end">
          <Button disabled={pending || !label.trim()}>
            {pending ? <Spinner /> : <Plus className="size-4" />}
            {ch.apiCreate}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ApiCard({ c, publicUrl }: { c: ChannelItem; publicUrl: string | null }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [shown, setShown] = useState(false);
  const [pending, start] = useTransition();
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => publicUrl ?? window.location.origin,
    () => publicUrl ?? "",
  );
  const a = c.api!;
  const [note, setNote] = useState(a.botNote);
  return (
    <Card className="space-y-4 p-5">
      <ChannelHeader
        c={c}
        icon={<Bot className="size-5" />}
        title={
          <span className="block min-w-0">
            {ch.api}
            <span className="block truncate text-sm font-normal text-muted">{a.label}</span>
          </span>
        }
      />
      <CopyLine label={ch.apiUrl} value={`${origin}/api/agent/${c.id}`} />
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{ch.apiKey}</span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShown(!shown)} title={ch.apiShow}>
              <Eye className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              title={ch.apiRegenerate}
              onClick={() => {
                if (confirm(ch.apiRegenerateConfirm)) start(async () => void (await regenerateApiKey(c.id)));
              }}
            >
              {pending ? <Spinner /> : <RefreshCw className="size-4" />}
            </Button>
          </span>
        </div>
        <CopyLine value={a.key} masked={!shown} />
      </div>
      <Field label={ch.apiBotNote} hint={ch.apiBotNoteHint}>
        <Textarea
          rows={2}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== a.botNote && start(async () => void (await updateApiChannel(c.id, { botNote: note })))}
          placeholder={ch.apiBotNotePlaceholder}
        />
      </Field>
      <Toggle
        label={ch.apiOrderNotes}
        hint={ch.apiOrderNotesHint}
        checked={a.orderNotes}
        disabled={pending}
        onChange={(v) => start(async () => void (await updateApiChannel(c.id, { orderNotes: v })))}
      />
      <Toggle
        label={ch.apiFollowUps}
        hint={ch.apiFollowUpsHint}
        checked={a.followUps}
        disabled={pending}
        onChange={(v) => start(async () => void (await updateApiChannel(c.id, { followUps: v })))}
      />
      <Toggle
        label={ch.apiCommentsApproval}
        hint={ch.apiCommentsApprovalHint}
        checked={a.approval}
        disabled={pending}
        onChange={(v) => start(async () => void (await updateApiChannel(c.id, { approval: v })))}
      />
      <details className="group text-xs text-muted">
        <summary className="cursor-pointer select-none hover:text-text">{ch.apiDev}</summary>
        <p className="mt-1.5 leading-relaxed">{ch.apiNote}</p>
      </details>
    </Card>
  );
}

function CopyLine({ label, value, masked }: { label?: string; value: string; masked?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <div className="mb-1.5 text-sm font-medium">{label}</div>}
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-xs">
          {masked ? "•".repeat(24) : value}
        </code>
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          <span className="hidden sm:inline">{copied ? t.channels.copied : t.channels.copy}</span>
        </Button>
      </div>
    </div>
  );
}
