"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
  ArrowLeft,
  AudioLines,
  Bot,
  BookOpen,
  Check,
  CheckCircle2,
  Contact,
  ExternalLink,
  FileText,
  Film,
  FlaskConical,
  Hand,
  Image as ImageIcon,
  MapPin,
  MessageSquare,
  Mic,
  MousePointerClick,
  Pencil,
  RotateCcw,
  SendHorizontal,
  Smile,
  Trash2,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { scenarioFromConversationAction } from "@/app/actions/tests";
import {
  deleteConversation,
  approveDraft,
  markRead,
  rejectDraft,
  returnToAgent,
  sendOperatorMessage,
  setConversationStatus,
  takeOver,
} from "@/app/actions/inbox";
import type { ConversationContext, MessageMeta } from "@/db/schema";
import { useI18n } from "@/lib/i18n/client";
import { Button, Spinner, cx } from "@/components/ui";
import type { ChannelType } from "@/db/schema";
import { CHANNEL_ICONS, ContactAvatar, contactLabel } from "./list";
import { InfoToggle } from "./info-panel";

// Значки для сообщений из журнала бота: что именно прислал клиент или бот
const KIND_ICONS: Record<string, LucideIcon> = {
  photo: ImageIcon,
  sticker: Smile,
  voice: Mic,
  video: Video,
  video_note: Video,
  animation: Film,
  audio: AudioLines,
  document: FileText,
  location: MapPin,
  contact: Contact,
  button: MousePointerClick,
  edit: Pencil,
  other: MessageSquare,
};

export type ThreadData = {
  id: string;
  contactName: string;
  contactHandle: string;
  channelType: ChannelType;
  channelName: string;
  kind: "dm" | "comment";
  context: ConversationContext | null;
  mode: "ai" | "human";
  status: "open" | "closed";
  unread: number;
  clientName: string;
  agentId: string;
  agentName: string;
  agentIcon: string;
  /** Можно ли менеджеру писать клиенту отсюда (для своего бота — если он забирает ответы менеджера) */
  botReplies: boolean;
  typing: boolean;
  messages: {
    id: string;
    role: "user" | "assistant" | "operator" | "system" | "bot";
    text: string;
    meta: MessageMeta | null;
    status: "sent" | "draft" | "rejected";
    createdAt: Date;
    author: string | null;
  }[];
};

export function Thread({ data, backHref }: { data: ThreadData; backHref: string }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [pending, start] = useTransition();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // «В автотест»: создан сценарий-повтор этого разговора (ссылка на вкладку проверки агента)
  const [scenarioNote, setScenarioNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { timeStyle: "short" });

  // Открыли диалог — непрочитанные сбрасываем.
  useEffect(() => {
    if (data.unread > 0) void markRead(data.id);
  }, [data.id, data.unread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [data.id, data.messages.length, data.typing]);

  const run = (fn: () => Promise<{ error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.error) setError(r.error);
    });

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    run(async () => {
      const r = await sendOperatorMessage(data.id, body);
      if (r.error) setText(body);
      return r;
    });
  };

  const systemText = (code: string) => {
    const key = code.split(":")[0] as keyof typeof t.inbox.system;
    return t.inbox.system[key] ?? `${t.inbox.system.error}: ${code}`;
  };

  const ChannelIcon = CHANNEL_ICONS[data.channelType];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Link href={backHref} replace className="text-muted hover:text-text md:hidden">
          <ArrowLeft className="size-5" />
        </Link>
        <ContactAvatar id={data.id} label={contactLabel(data, t.inbox)} size={38} anonymous={!data.contactName && !data.contactHandle} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{contactLabel(data, t.inbox)}</div>
          <div className="flex items-center gap-1.5 truncate text-xs text-muted">
            <span
              className={cx(
                "inline-flex shrink-0 items-center gap-1 font-medium whitespace-nowrap",
                data.status === "closed" ? "text-muted" : data.mode === "human" ? "text-amber-600 dark:text-amber-400" : "text-success",
              )}
            >
              <span className={cx("size-1.5 rounded-full", data.status === "closed" ? "bg-muted" : data.mode === "human" ? "bg-amber-500" : "bg-success")} />
              {data.status === "closed" ? t.inbox.closed : data.mode === "human" ? t.inbox.humanMode : t.inbox.agentMode}
            </span>
            ·
            <ChannelIcon className="size-3 shrink-0" />
            <span className="truncate">
              {data.contactHandle && data.contactName ? `${data.contactHandle} · ` : ""}
              {data.channelName === "Widget" ? t.channels.widget : data.channelName} · {data.clientName} ·{" "}
              <Link href={`/agents/${data.agentId}`} className="hover:text-accent">
                {data.agentIcon} {data.agentName}
              </Link>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pending && <Spinner className="mr-1 text-muted" />}
          {!data.botReplies || data.status === "closed" ? null : data.mode === "ai" ? (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => takeOver(data.id))}>
              <Hand className="size-4" />
              <span className="hidden sm:inline">{t.inbox.takeOver}</span>
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => returnToAgent(data.id))}>
              <Bot className="size-4" />
              <span className="hidden sm:inline">{t.inbox.returnToAgent}</span>
            </Button>
          )}
          <IconAction
            title={t.inbox.toTestHint}
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = await scenarioFromConversationAction(data.id);
                if (r.ok) setScenarioNote(r.name ?? "");
                return r;
              })
            }
          >
            <FlaskConical className="size-4" />
          </IconAction>
          {data.status === "open" ? (
            <IconAction title={t.inbox.close} disabled={pending} onClick={() => run(() => setConversationStatus(data.id, "closed"))}>
              <CheckCircle2 className="size-4" />
            </IconAction>
          ) : (
            <IconAction title={t.inbox.reopen} disabled={pending} onClick={() => run(() => setConversationStatus(data.id, "open"))}>
              <RotateCcw className="size-4" />
            </IconAction>
          )}
          <IconAction
            title={t.inbox.delete}
            danger
            disabled={pending}
            onClick={() => {
              if (!confirm(t.inbox.deleteConfirm)) return;
              run(async () => {
                const r = await deleteConversation(data.id);
                if (!r.error) router.replace(backHref);
                return r;
              });
            }}
          >
            <Trash2 className="size-4" />
          </IconAction>
          <InfoToggle />
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto bg-surface-2/50 px-4 py-4">
        {data.kind === "comment" && data.context && (
          <div className="rounded-xl border border-border bg-surface px-3 py-2 text-xs">
            <div className="mb-1 flex items-center justify-between gap-2 font-medium text-muted">
              {t.inbox.commentOn}
              {data.context.postUrl && (
                <a href={data.context.postUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                  {t.inbox.openPost}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            {data.context.postText && <p className="line-clamp-3 whitespace-pre-wrap text-text">{data.context.postText}</p>}
          </div>
        )}
        {data.channelType === "email" && data.context?.subject && (
          <div className="rounded-xl border border-border bg-surface px-3 py-2 text-xs">
            <span className="font-medium text-muted">{t.inbox.emailSubject}: </span>
            <span className="text-text">{data.context.subject}</span>
          </div>
        )}
        {data.messages.map((m) => {
          if (m.status === "draft") return <DraftMessage key={m.id} id={m.id} text={m.text} />;
          if (m.role === "system") {
            return (
              <div key={m.id} className="text-center text-xs text-muted">
                <span className={cx("rounded-full px-3 py-1", m.meta?.error ? "bg-danger/10 text-danger" : "bg-surface-2")}>
                  {systemText(m.text)}
                  {m.meta?.reason && `: ${m.meta.reason}`}
                  {m.meta?.repeats ? ` · ${t.inbox.handoffRepeats.replace("{n}", String(m.meta.repeats))}` : ""}
                  {m.author && ` · ${m.author}`} · {time.format(new Date(m.createdAt))}
                </span>
                {m.meta?.summary && (
                  <div className="mx-auto mt-2 max-w-md whitespace-pre-wrap rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-xs text-text">
                    <div className="mb-0.5 font-medium text-amber-700 dark:text-amber-400">{t.inbox.summary}</div>
                    {m.meta.summary}
                  </div>
                )}
              </div>
            );
          }
          const ours = m.role !== "user";
          const kind = m.meta?.kind;
          // Реакция клиента на сообщение — строкой, не пузырём
          if (kind === "reaction") {
            return (
              <div key={m.id} className="flex justify-start px-1 text-xs text-muted">
                <span className="rounded-full bg-surface px-2.5 py-1 ring-1 ring-border">
                  {t.inbox.kinds.reaction}: <span className="text-base leading-none">{m.text}</span> · {time.format(new Date(m.createdAt))}
                </span>
              </div>
            );
          }
          const KindIcon = kind ? KIND_ICONS[kind] ?? KIND_ICONS.other : null;
          const stickerOnly = kind === "sticker" && /^\p{Extended_Pictographic}/u.test(m.text.trim()) && m.text.trim().length <= 8;
          return (
            <div key={m.id} className={cx("flex flex-col", ours ? "items-end" : "items-start")}>
              <div
                className={cx(
                  "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                  m.status === "rejected" && "line-through opacity-50",
                  m.role === "user" && "rounded-bl-md border border-border bg-surface",
                  m.role === "assistant" && "rounded-br-md bg-accent-soft text-text",
                  m.role === "operator" && "rounded-br-md bg-amber-500/15 text-text",
                  m.role === "bot" && "rounded-br-md border border-dashed border-border bg-surface-2/70 text-text",
                )}
              >
                {KindIcon && (
                  <span className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted">
                    <KindIcon className="size-3.5" />
                    {t.inbox.kinds[kind as keyof typeof t.inbox.kinds] ?? t.inbox.kinds.other}
                  </span>
                )}
                {m.meta?.thumb && (
                  <a href={`/api/media/${m.meta.thumb}`} target="_blank" rel="noreferrer" className="-mx-1 mb-1 block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- превью из своей папки media, без оптимизатора */}
                    <img src={`/api/media/${m.meta.thumb}`} alt="" loading="lazy" className="max-h-64 max-w-full rounded-xl object-contain" />
                  </a>
                )}
                {stickerOnly ? <span className="text-4xl leading-tight">{m.text}</span> : m.text}
                {m.meta?.vision && (
                  <span className="mt-1.5 block border-t border-border/60 pt-1.5 text-xs text-muted italic">
                    {t.inbox.vision}: {m.meta.vision}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-1 px-1 text-[11px] text-muted">
                {m.role === "assistant" && <Bot className="size-3" />}
                {m.role === "operator" && <Hand className="size-3" />}
                {m.role === "bot" && <MessageSquare className="size-3" />}
                {m.status === "rejected" && `${t.inbox.rejected} · `}
                {m.role === "assistant" ? t.inbox.agent : m.role === "operator" ? (m.author ?? t.inbox.you) : m.role === "bot" ? t.inbox.bot : ""}
                {ours && " · "}
                {time.format(new Date(m.createdAt))}
                {m.meta?.kb && (
                  <span className="flex items-center gap-1" title={m.meta.kb.sources.join(", ")}>
                    · <BookOpen className="size-3" />
                    {m.meta.kb.sources.length}
                  </span>
                )}
                {m.meta?.cost !== undefined && ` · ${m.meta.cost.toFixed(4)}`}
                {m.meta?.followUp && ` · ${t.inbox.followUp}`}
                {m.meta?.rating === "up" && " · 👍"}
                {m.meta?.rating === "down" && <span className="text-danger"> · 👎</span>}
                {m.meta?.fromSite && ` · ${t.inbox.fromSite}`}
              </div>
              {m.meta?.unverified?.length ? (
                <div className="mt-0.5 px-1 text-[11px] text-warning" title={t.inbox.unverifiedHint}>
                  ⚠️ {t.inbox.unverified}: {m.meta.unverified.join(", ")}
                </div>
              ) : null}
              {m.meta?.qa?.note ? (
                <details className={cx("mt-1 max-w-[85%] rounded-lg px-2.5 py-1.5 text-[12px]", m.meta.qa.severity === "high" ? "bg-danger/8 text-danger" : "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
                  <summary className="cursor-pointer select-none">
                    {m.meta.qa.severity === "high" ? "🔴" : "🟡"} {t.inbox.qaTitle}: {m.meta.qa.note}
                  </summary>
                  {m.meta.qa.better && (
                    <p className="mt-1 text-text/80">
                      <b>{t.inbox.qaBetter}:</b> {m.meta.qa.better}
                    </p>
                  )}
                </details>
              ) : null}
            </div>
          );
        })}
        {data.typing && data.mode === "ai" && (
          <div className="flex items-center justify-end gap-2 text-xs text-muted">
            <Spinner className="size-3" />
            {t.inbox.typing}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {scenarioNote !== null && (
        <p className="border-t border-border bg-success/5 px-4 py-2 text-xs text-success">
          {t.inbox.toTestDone}: {scenarioNote} —{" "}
          <Link href={`/agents/${data.agentId}/tests`} className="underline">
            {t.inbox.toTestOpen}
          </Link>
        </p>
      )}
      {error && <p className="border-t border-border bg-danger/5 px-4 py-2 text-xs text-danger">{error}</p>}
      {data.botReplies && data.status !== "closed" && data.context?.managerDraft?.text && !text && (
        <div className="flex items-start gap-2 border-t border-border bg-accent-soft/40 px-4 py-2.5 text-sm">
          <span className="shrink-0">💡</span>
          <span className="line-clamp-2 min-w-0 flex-1 text-muted" title={data.context.managerDraft.text}>
            {data.context.managerDraft.text}
          </span>
          <button type="button" onClick={() => setText(data.context?.managerDraft?.text ?? "")} className="shrink-0 text-xs font-semibold text-accent hover:underline">
            {t.inbox.useDraft}
          </button>
        </div>
      )}
      {!data.botReplies ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted">{t.inbox.apiReplyInBot}</p>
      ) : (
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={data.mode === "ai" ? t.inbox.placeholderAi : t.inbox.placeholder}
          className="max-h-40 min-h-11 flex-1 resize-y rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-accent/15"
        />
        <Button type="submit" disabled={!text.trim() || pending} title={t.inbox.send}>
          <SendHorizontal className="size-4" />
        </Button>
      </form>
      )}
      {data.botReplies && data.channelType === "api" && data.kind !== "comment" && (
        <p className="px-4 pb-3 text-xs text-muted">{t.inbox.apiViaBot}</p>
      )}
    </div>
  );
}

function IconAction({ title, onClick, disabled, danger, children }: { title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "grid size-8 place-items-center rounded-lg text-muted transition hover:bg-surface-2 disabled:opacity-50",
        danger ? "hover:text-danger" : "hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

/** Черновик ответа агента в публичной ветке: менеджер публикует как есть, правит или отклоняет. */
function DraftMessage({ id, text }: { id: string; text: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r.error) setError(r.error);
    });
  return (
    <div className="flex flex-col items-end">
      <div className="w-full max-w-[80%] rounded-2xl rounded-br-md border-2 border-dashed border-amber-500/50 bg-amber-500/5 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          <Bot className="size-3" />
          {t.inbox.draft}
        </div>
        {editing ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-sm outline-none focus:border-accent"
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{value}</p>
        )}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          {pending && <Spinner className="text-muted" />}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => rejectDraft(id))}>
            <X className="size-4" />
            {t.inbox.reject}
          </Button>
          {!editing && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              {t.inbox.edit}
            </Button>
          )}
          <Button size="sm" disabled={pending || !value.trim()} onClick={() => run(() => approveDraft(id, value))}>
            <Check className="size-4" />
            {t.inbox.approve}
          </Button>
        </div>
      </div>
    </div>
  );
}
