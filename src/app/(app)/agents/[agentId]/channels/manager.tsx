"use client";

import { useActionState, useEffect, useState, useSyncExternalStore, useTransition, useOptimistic } from "react";
import Link from "next/link";
import { AlertTriangle, AtSign, Bot, Camera, Check, Copy, ExternalLink, Eye, Globe, Mail, MessageCircle, MessagesSquare, Phone, PhoneCall, Plus, Smartphone, Power, RefreshCw, Send, Trash2 } from "lucide-react";
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
  updateWidget, addWhatsAppChannel, saveWhatsAppSettings, syncWhatsAppTemplates, addViberChannel, updateViberChannel, saveInstagramTriggers, addVoiceChannel, updateVoiceChannel, addMessengerChannel, addSmsChannel } from "@/app/actions/channels";
import { WIDGET_LANGS, type ChannelType, type WidgetConfig } from "@/db/schema";
import { useI18n } from "@/lib/i18n/client";
import type { AddKind } from "@/lib/channels/add-kinds";
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea, cx } from "@/components/ui";
import { InfoHint } from "@/components/hint";
import { ask } from "@/components/confirm-dialog";
import { toast } from "@/components/toast";

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
  whatsapp: {
    phone: string;
    name: string;
    wabaId: string;
    templates: { name: string; language: string; category: string; body: string; params: number }[];
    proactiveTemplate: { name: string; language: string } | null;
    price: { service: number; template: number };
    month: { messages: number; cost: number };
  } | null;
  social: { dm?: boolean; comments?: boolean; approval: boolean; tokenExpiresAt: number; triggers?: { keyword: string; dm: string; reply: string; postId?: string }[] } | null;
  email: { address: string; approval: boolean; fromName: string } | null;
  api: { key: string; label: string; approval: boolean; botNote: string; followUps: boolean; orderNotes: boolean; ratingInvite: boolean } | null;
  telegram: { comments: boolean; approval: boolean; group: { id: number; title: string; channel?: string } | null } | null;
  viber?: { uri: string; welcome: string } | null;
  voice?: { key: string; provider: "vapi" | "elevenlabs" | "other"; phone: string } | null;
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
  initialAdd = null,
}: {
  agentId: string;
  agentStatus: "draft" | "active" | "paused";
  channels: ChannelItem[];
  publicUrl: string | null;
  socialReady: SocialReady;
  isAdmin: boolean;
  /** Открыть форму нового канала сразу (ссылка с карты агента: ?add=telegram) */
  initialAdd?: AddKind | null;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState<AddKind | null>(initialAdd);
  // Пришли с карты агента (?add=…) — сразу к форме нового канала
  useEffect(() => {
    if (initialAdd) document.getElementById("add-channel")?.scrollIntoView({ behavior: "smooth" });
  }, [initialAdd]);
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
        ) : c.type === "viber" ? (
          <ViberCard key={c.id} c={c} />
        ) : c.type === "voice" ? (
          <VoiceCard key={c.id} c={c} publicUrl={publicUrl} />
        ) : c.type === "messenger" ? (
          <SimpleCard key={c.id} c={c} icon={<MessagesSquare className="size-5" />} title={`Messenger · ${c.name}`} note={t.channels.messengerNote} />
        ) : c.type === "sms" ? (
          <SimpleCard key={c.id} c={c} icon={<Smartphone className="size-5" />} title={`SMS · ${c.name}`} note={t.channels.smsNote} copy={`${publicUrl ?? ""}/api/webhooks/sms/${c.id}`} />
        ) : (
          <SocialCard key={c.id} c={c} agentId={agentId} errText={errText} />
        ),
      )}

      <div id="add-channel" className="scroll-mt-6">
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
            icon={<Phone className="size-5" />}
            title="Viber"
            desc={t.channels.viberDesc}
            active={adding === "viber"}
            onClick={() => setAdding(adding === "viber" ? null : "viber")}
          />
          <AddCard
            icon={<MessagesSquare className="size-5" />}
            title="Facebook Messenger"
            desc={t.channels.messengerDesc}
            active={adding === "messenger"}
            onClick={() => setAdding(adding === "messenger" ? null : "messenger")}
          />
          <AddCard
            icon={<Smartphone className="size-5" />}
            title="SMS"
            desc={t.channels.smsDesc}
            active={adding === "sms"}
            onClick={() => setAdding(adding === "sms" ? null : "sms")}
          />
          <AddCard
            icon={<PhoneCall className="size-5" />}
            title={t.channels.voice}
            desc={t.channels.voiceDesc}
            active={adding === "voice"}
            onClick={() => setAdding(adding === "voice" ? null : "voice")}
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
        {adding === "voice" && <VoiceForm agentId={agentId} onDone={() => setAdding(null)} />}
        {adding === "messenger" && <MessengerForm agentId={agentId} onDone={() => setAdding(null)} ready={socialReady.whatsapp || socialReady.instagram} />}
        {adding === "sms" && <SmsForm agentId={agentId} onDone={() => setAdding(null)} />}
        {adding === "viber" && <ViberForm agentId={agentId} onDone={() => setAdding(null)} errText={errText} />}
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
  const { t, locale, timeZone } = useI18n();
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
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
  // Включение и выключение — сразу на экране, сохранение в фоне; ошибка — значение вернётся само
  const [enabled, setEnabled] = useOptimistic(c.enabled);
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 font-semibold">{title}</div>
        <Badge tone={enabled ? (c.error ? "warning" : "success") : "neutral"}>
          {enabled ? (c.type === "telegram" && c.live && !c.error ? t.channels.polling : t.channels.enabled) : t.channels.disabled}
        </Badge>
        {enabled && <LastActivity c={c} />}
      </div>
      <Button
        size="sm"
        variant="ghost"
        title={enabled ? t.channels.disable : t.channels.enable}
        aria-pressed={enabled}
        onClick={() =>
          start(async () => {
            setEnabled(!enabled);
            const r = await setChannelEnabled(c.id, !enabled).catch(() => ({ error: "failed" }));
            if (r.error) toast(t.shell.saveFailed, "error");
          })
        }
      >
        <Power className={cx("size-4", enabled && "text-success")} />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="hover:text-danger"
        disabled={pending}
        title={t.common.delete}
        onClick={async () => {
          if (await ask(t.common.confirmDelete)) start(async () => void (await deleteChannel(c.id)));
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
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" name="voice" defaultChecked={Boolean(w.voice)} className="mt-0.5 size-4 accent-[var(--accent)]" />
          <span>
            <span className="font-medium">{t.channels.widgetVoice}</span>
            <span className="block text-xs text-muted">{t.channels.widgetVoiceHint}</span>
          </span>
        </label>
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

type Trigger = { keyword: string; dm: string; reply: string; postId?: string };

/** «Напишите ПРАЙС в комментариях» — слово → сообщение в директ автору и короткий ответ под комментарием. */
function IgTriggers({ id, initial }: { id: string; initial: Trigger[] }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [list, setList] = useState<Trigger[]>(initial);
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const upd = (i: number, patch: Partial<Trigger>) => (setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x))), setMsg(null));
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <div className="text-sm font-semibold">{ch.igTriggers}</div>
        <p className="text-xs text-muted">{ch.igTriggersHint}</p>
      </div>
      {list.map((x, i) => (
        <div key={i} className="grid gap-2 rounded-lg bg-surface-2/50 p-3 sm:grid-cols-[160px_minmax(0,1fr)_auto]">
          <Input placeholder={ch.igTriggerKeyword} value={x.keyword} maxLength={40} onChange={(e) => upd(i, { keyword: e.target.value })} />
          <div className="space-y-2">
            <Textarea rows={2} placeholder={ch.igTriggerDm} value={x.dm} maxLength={1000} onChange={(e) => upd(i, { dm: e.target.value })} />
            <Input placeholder={ch.igTriggerReply} value={x.reply} maxLength={300} onChange={(e) => upd(i, { reply: e.target.value })} />
            <Input placeholder={ch.igTriggerPost} value={x.postId ?? ""} maxLength={40} onChange={(e) => upd(i, { postId: e.target.value })} />
          </div>
          <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setList(list.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setList([...list, { keyword: "", dm: "", reply: ch.igTriggerReplyDefault }])}>
          <Plus className="size-4" />
          {ch.igTriggerAdd}
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveInstagramTriggers(id, list);
              setMsg(r.ok ? { text: t.common.saved } : { error: true, text: ch.igTriggerInvalid });
            })
          }
        >
          {t.common.save}
        </Button>
        {msg && <span className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</span>}
      </div>
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
      {isIg && <IgTriggers id={c.id} initial={s.triggers ?? []} />}
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

function MessengerForm({ agentId, onDone, ready }: { agentId: string; onDone: () => void; ready: boolean }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="mt-3 space-y-3 p-5">
      <p className="text-sm text-muted">{ready ? ch.messengerHow : ch.messengerNotReady}</p>
      <Field label={ch.messengerToken}>
        <Input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <div className="flex items-center justify-end gap-3">
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button disabled={pending || !token.trim() || !ready} onClick={() => start(async () => { const r = await addMessengerChannel(agentId, token); if (r.ok) onDone(); else setError(r.error ?? "error"); })}>
          {pending ? <Spinner /> : <Plus className="size-4" />}
          {ch.connect}
        </Button>
      </div>
    </Card>
  );
}

function SmsForm({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [v, setV] = useState({ accountSid: "", authToken: "", from: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="mt-3 space-y-3 p-5">
      <p className="text-sm text-muted">{ch.smsHow}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Account SID">
          <Input value={v.accountSid} placeholder="AC…" onChange={(e) => setV({ ...v, accountSid: e.target.value })} />
        </Field>
        <Field label="Auth Token">
          <Input type="password" autoComplete="new-password" value={v.authToken} onChange={(e) => setV({ ...v, authToken: e.target.value })} />
        </Field>
        <Field label={ch.smsFrom}>
          <Input value={v.from} placeholder="+1 …" onChange={(e) => setV({ ...v, from: e.target.value.replace(/[\s()-]/g, "") })} />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-3">
        {error && <p className="text-sm text-danger">{(ch.errors as Record<string, string>)[error] ?? error}</p>}
        <Button disabled={pending || !v.accountSid || !v.authToken || !v.from} onClick={() => start(async () => { const r = await addSmsChannel(agentId, v); if (r.ok) onDone(); else setError(r.error ?? "error"); })}>
          {pending ? <Spinner /> : <Plus className="size-4" />}
          {ch.connect}
        </Button>
      </div>
    </Card>
  );
}

/** Простой канал: заголовок, пояснение и (если нужно) адрес для настройки у провайдера. */
function SimpleCard({ c, icon, title, note, copy }: { c: ChannelItem; icon: React.ReactNode; title: string; note: string; copy?: string }) {
  const { t } = useI18n();
  return (
    <Card className="space-y-3 p-5">
      <ChannelHeader c={c} icon={icon} title={title} />
      <p className="text-sm text-muted">{note}</p>
      {copy && <CopyLine label={t.channels.webhookUrl} value={copy} />}
    </Card>
  );
}

function VoiceForm({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [pending, start] = useTransition();
  return (
    <Card className="mt-3 space-y-3 p-5">
      <p className="text-sm text-muted">{ch.voiceHow}</p>
      <div className="flex flex-wrap gap-2">
        {(["vapi", "elevenlabs", "other"] as const).map((p) => (
          <Button key={p} variant="secondary" disabled={pending} onClick={() => start(async () => void ((await addVoiceChannel(agentId, p)).ok && onDone()))}>
            {pending ? <Spinner /> : <Plus className="size-4" />}
            {ch.voiceProviders[p]}
          </Button>
        ))}
      </div>
    </Card>
  );
}

/** Звонки: адрес и ключ для голосовой платформы, номер, пошаговая настройка (Vapi, ElevenLabs, номер +380 через SIP). */
function VoiceCard({ c, publicUrl }: { c: ChannelItem; publicUrl: string | null }) {
  const { t } = useI18n();
  const ch = t.channels;
  const v = c.voice!;
  const [shown, setShown] = useState(false);
  const [phone, setPhone] = useState(v.phone);
  const [pending, start] = useTransition();
  const origin = useSyncExternalStore(noopSubscribe, () => publicUrl ?? window.location.origin, () => publicUrl ?? "");
  return (
    <Card className="space-y-4 p-5">
      <ChannelHeader c={c} icon={<PhoneCall className="size-5" />} title={`${ch.voice} · ${ch.voiceProviders[v.provider]}`} />
      <CopyLine label={ch.voiceUrl} value={`${origin}/api/agent/${c.id}`} />
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{ch.apiKey}</span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setShown(!shown)} title={ch.apiShow}>
              <Eye className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} title={ch.apiRegenerate} onClick={async () => await ask(ch.apiRegenerateConfirm) && start(async () => void (await regenerateApiKey(c.id)))}>
              <RefreshCw className="size-4" />
            </Button>
          </span>
        </div>
        <CopyLine value={v.key} masked={!shown} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={ch.voicePhone} hint={ch.voicePhoneHint}>
          <Input className="w-56" value={phone} placeholder="+380 44 000 00 00" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => void (await updateVoiceChannel(c.id, phone)))}>
          {t.common.save}
        </Button>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-accent">{ch.voiceSteps}</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted">
          {(ch.voiceGuide[v.provider] as string[]).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <div className="mt-3 font-medium">{ch.voiceSipTitle}</div>
        <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-muted">
          {(ch.voiceSip as string[]).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </details>
    </Card>
  );
}

function ViberForm({ agentId, onDone, errText }: { agentId: string; onDone: () => void; errText: (c: string | null | undefined) => string | null }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [token, setToken] = useState("");
  const [welcome, setWelcome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="mt-3 p-5">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await addViberChannel(agentId, token, welcome);
            if (r.ok) onDone();
            else setError(r.error ?? "error");
          });
        }}
      >
        <p className="text-sm text-muted">{ch.viberHow}</p>
        <Field label={ch.viberToken}>
          <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="new-password" className="font-mono" required />
        </Field>
        <Field label={ch.viberWelcome} hint={ch.viberWelcomeHint}>
          <Textarea rows={2} maxLength={500} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {error && <p className="text-sm text-danger">{errText(error)}</p>}
          <Button disabled={pending || !token.trim()}>
            {pending ? <Spinner /> : <Plus className="size-4" />}
            {ch.viberConnect}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ViberCard({ c }: { c: ChannelItem }) {
  const { t } = useI18n();
  const ch = t.channels;
  const [welcome, setWelcome] = useState(c.viber?.welcome ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-3 p-5">
      <ChannelHeader c={c} icon={<Phone className="size-5" />} title={`Viber · ${c.name}`} />
      {c.viber?.uri && (
        <a href={`viber://pa?chatURI=${encodeURIComponent(c.viber.uri)}`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          <ExternalLink className="size-3.5" />
          {ch.viberOpen}
        </a>
      )}
      <Field label={ch.viberWelcome} hint={ch.viberWelcomeHint}>
        <Textarea rows={2} maxLength={500} value={welcome} onChange={(e) => (setWelcome(e.target.value), setSaved(false))} />
      </Field>
      <div className="flex items-center gap-3">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => setSaved(Boolean((await updateViberChannel(c.id, welcome)).ok)))}>
          {ch.viberSave}
        </Button>
        {saved && <Check className="size-4 text-success" />}
      </div>
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
      {c.whatsapp && <WhatsAppEconomy id={c.id} wa={c.whatsapp} />}
    </Card>
  );
}

/** Шаблоны для сообщений вне 24-часового окна и цены сообщений для учёта расходов клиента. */
function WhatsAppEconomy({ id, wa }: { id: string; wa: NonNullable<ChannelItem["whatsapp"]> }) {
  const { t } = useI18n();
  const w = t.channels.wa;
  const [waba, setWaba] = useState(wa.wabaId);
  const [tpl, setTpl] = useState(wa.proactiveTemplate ? `${wa.proactiveTemplate.name}|${wa.proactiveTemplate.language}` : "");
  const [price, setPrice] = useState({ service: String(wa.price.service), template: String(wa.price.template) });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const chosen = wa.templates.find((x) => `${x.name}|${x.language}` === tpl);
  const save = () =>
    start(async () => {
      const [name, language] = tpl.split("|");
      const r = await saveWhatsAppSettings(id, { wabaId: waba, proactiveTemplate: tpl ? { name, language } : null, price: { service: Number(price.service) || 0, template: Number(price.template) || 0 } });
      setMsg(r.error ? { ok: false, text: w.errors[r.error as keyof typeof w.errors] ?? r.error } : { ok: true, text: w.saved });
    });
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="text-sm font-semibold">{w.title}</div>
      <p className="text-xs text-muted">{w.hint}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={w.waba} hint={w.wabaHint}>
          <Input className="w-56 font-mono text-[13px]" value={waba} maxLength={25} onChange={(e) => setWaba(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || !waba}
          onClick={() =>
            start(async () => {
              await saveWhatsAppSettings(id, { wabaId: waba, proactiveTemplate: wa.proactiveTemplate, price: wa.price });
              const r = await syncWhatsAppTemplates(id);
              setMsg(r.error ? { ok: false, text: w.errors[r.error as keyof typeof w.errors] ?? r.error } : { ok: true, text: w.synced.replace("{n}", String(r.count ?? 0)) });
            })
          }
        >
          {w.sync}
        </Button>
      </div>
      <Field label={w.template} hint={w.templateHint}>
        <Select className="w-full max-w-md" value={tpl} onChange={(e) => setTpl(e.target.value)}>
          <option value="">{w.noTemplate}</option>
          {wa.templates.map((x) => (
            <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>
              {x.name} · {x.language} · {x.category}
            </option>
          ))}
        </Select>
      </Field>
      {chosen && <p className="rounded-lg bg-surface-2/60 p-2 text-xs whitespace-pre-wrap">{chosen.body}</p>}
      {!tpl && <p className="text-xs text-amber-600 dark:text-amber-400">{w.noTemplateWarn}</p>}
      <div className="flex flex-wrap gap-2">
        <Field label={w.priceService}>
          <Input type="number" step="0.001" min={0} className="w-28" value={price.service} onChange={(e) => setPrice({ ...price, service: e.target.value })} />
        </Field>
        <Field label={w.priceTemplate}>
          <Input type="number" step="0.001" min={0} className="w-28" value={price.template} onChange={(e) => setPrice({ ...price, template: e.target.value })} />
        </Field>
      </div>
      <p className="text-xs text-muted">{w.priceHint}</p>
      <p className="text-xs">{w.month.replace("{n}", String(wa.month.messages)).replace("{usd}", wa.month.cost.toFixed(2))}</p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending} onClick={save}>
          {w.save}
        </Button>
        {msg && <span className={msg.ok ? "text-sm text-success" : "text-sm text-danger"}>{msg.text}</span>}
      </div>
    </div>
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
              onClick={async () => {
                if (await ask(ch.apiRegenerateConfirm)) start(async () => void (await regenerateApiKey(c.id)));
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
        label={ch.apiRatingInvite}
        hint={ch.apiRatingInviteHint}
        checked={a.ratingInvite}
        disabled={pending}
        onChange={(v) => start(async () => void (await updateApiChannel(c.id, { ratingInvite: v })))}
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
