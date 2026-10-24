"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
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
  ShieldCheck,
  Smile,
  Trash2,
  Video,
  X,
  type LucideIcon,
  ClipboardList,
  Download,
  UserX,
} from "lucide-react";
import { scenarioFromConversationAction } from "@/app/actions/tests";
import {
  deleteConversation,
  erasePersonAction,
  approveDraft,
  checkOperatorDraft,
  callBriefAction,
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
import { isSticker } from "@/lib/sticker";

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
  // «Проверить ответ»: оценка черновика менеджера и улучшенный вариант
  const [review, setReview] = useState<{ score: number; problems: string[]; better: string } | null>(null);
  const [checking, startCheck] = useTransition();
  // «В автотест»: создан сценарий-повтор этого разговора (ссылка на вкладку проверки агента)
  const [scenarioNote, setScenarioNote] = useState<string | null>(null);
  // «Бриф перед звонком»: кто клиент, что обсудили, возражения, о чём говорить
  const [brief, setBrief] = useState<string | null>(null);
  const [briefing, startBrief] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { timeStyle: "short" });
  const dayFmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const [now] = useState(() => Date.now());
  /** Разделитель дня перед первым сообщением дня: «Сегодня», «Вчера» или дата. */
  const daySep = (i: number) => {
    const d = new Date(data.messages[i].createdAt);
    const prev = i > 0 ? new Date(data.messages[i - 1].createdAt) : null;
    if (prev && prev.toDateString() === d.toDateString()) return null;
    const today = new Date(now);
    const yesterday = new Date(now - 86_400_000);
    const label = d.toDateString() === today.toDateString() ? t.nav.today : d.toDateString() === yesterday.toDateString() ? t.shell.yesterday : dayFmt.format(d);
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] font-medium text-muted" role="separator">
        <span className="h-px flex-1 bg-border" />
        <span className="first-letter:uppercase">{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  };
  /** Аватар у последнего сообщения подряд от того же отправителя — как в мессенджерах. */
  const lastOfGroup = (i: number) => {
    const m = data.messages[i];
    const next = data.messages[i + 1];
    return !next || next.role !== m.role || (m.role === "operator" && next.author !== m.author) || new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
  };
  const avatarOf = (m: ThreadData["messages"][number], i: number) => {
    if (!lastOfGroup(i)) return <span className="size-7 shrink-0" />;
    if (m.role === "user") return <ContactAvatar id={data.id} label={contactLabel(data, t.inbox)} size={28} anonymous={!data.contactName && !data.contactHandle} />;
    if (m.role === "operator")
      return (
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-amber-500/20 text-xs font-semibold text-amber-700 dark:text-amber-300" title={m.author ?? t.inbox.you}>
          {(m.author ?? t.inbox.you).trim().charAt(0).toUpperCase()}
        </span>
      );
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent" title={m.role === "bot" ? t.inbox.bot : t.inbox.agent}>
        {m.role === "bot" ? <MessageSquare className="size-3.5" /> : <Bot className="size-3.5" />}
      </span>
    );
  };

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
    setReview(null);
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
            title={t.inbox.brief}
            disabled={briefing}
            onClick={() =>
              startBrief(async () => {
                setError(null);
                const r = await callBriefAction(data.id);
                if (r.text) setBrief(r.text);
                else setError(t.inbox.briefFailed);
              })
            }
          >
            {briefing ? <Spinner className="size-4" /> : <ClipboardList className="size-4" />}
          </IconAction>
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
          <a href={`/api/privacy/${data.id}`} title={t.inbox.exportPerson} aria-label={t.inbox.exportPerson} className="grid size-8 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text">
            <Download className="size-4" />
          </a>
          <IconAction
            title={t.inbox.erasePerson}
            danger
            disabled={pending}
            onClick={() => {
              if (!confirm(t.inbox.erasePersonConfirm)) return;
              run(async () => {
                const r = await erasePersonAction(data.id);
                if (!r.error) router.replace(backHref);
                return r;
              });
            }}
          >
            <UserX className="size-4" />
          </IconAction>
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
      {brief && (
        <div className="relative border-b border-border bg-surface-2/50 px-4 py-3 text-sm">
          <button type="button" className="absolute top-2 right-3 text-xs text-muted hover:text-text" onClick={() => setBrief(null)}>
            {t.inbox.briefClose}
          </button>
          <div className="mb-1 text-xs font-semibold text-accent">{t.inbox.brief}</div>
          <div className="max-h-80 overflow-auto whitespace-pre-wrap pr-10">{brief.replace(/^##\s*/gm, "▸ ")}</div>
        </div>
      )}

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
        {data.messages.map((m, i) => (
          <Fragment key={m.id}>
          {daySep(i)}
          {((): ReactNode => {
          if (m.status === "draft") return <DraftMessage key={m.id} id={m.id} text={m.text} />;
          // Стикеры клиента подряд — одной строкой «Стикер ×N»
          const userSticker = (x?: ThreadData["messages"][number]) => x?.role === "user" && isSticker(x.text, x.meta?.kind);
          if (userSticker(m)) {
            if (userSticker(data.messages[i - 1])) return null;
            let n = 1;
            while (userSticker(data.messages[i + n])) n++;
            const emoji = data.messages
              .slice(i, i + n)
              .map((x) => x.text.trim())
              .filter((x) => /^\p{Extended_Pictographic}/u.test(x) && x.length <= 8);
            if (n > 1 || !emoji.length) {
              return (
                <div key={m.id} className="flex justify-start px-1 text-xs text-muted">
                  <span className="flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 ring-1 ring-border">
                    <Smile className="size-3.5" />
                    {emoji.length ? <span className="text-base leading-none">{emoji.slice(0, 6).join(" ")}</span> : t.inbox.kinds.sticker}
                    {n > 1 && ` ×${n}`} · {time.format(new Date(m.createdAt))}
                  </span>
                </div>
              );
            }
          }
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
            <div key={m.id} className={cx("flex items-end gap-2", ours && "flex-row-reverse")}>
              {avatarOf(m, i)}
            <div className={cx("flex min-w-0 flex-1 flex-col", ours ? "items-end" : "items-start")}>
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
                {m.meta?.check?.rewritten && (
                  <span className="text-success" title={`${t.inbox.checkFixedHint}\n${m.meta.check.problems.map((p) => `• ${p}`).join("\n")}`}>
                    ✓ {t.inbox.checkFixed} ·{" "}
                  </span>
                )}
                {m.meta?.operatorReview && (
                  <span
                    className={cx(m.meta.operatorReview.score >= 8 ? "text-success" : m.meta.operatorReview.score >= 6 ? "text-amber-600" : "text-danger")}
                    title={[`${t.inbox.review}: ${m.meta.operatorReview.score}/10`, ...m.meta.operatorReview.problems.map((p) => `• ${p}`), m.meta.operatorReview.better ? `\n${t.inbox.reviewBetter}:\n${m.meta.operatorReview.better}` : ""].filter(Boolean).join("\n")}
                  >
                    <ShieldCheck className="inline size-3" /> {m.meta.operatorReview.score}/10 ·{" "}
                  </span>
                )}
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
                {m.meta?.campaign ? ` · ${t.inbox.campaign} «${m.meta.campaign.name}»` : m.meta?.followUp && ` · ${t.inbox.followUp}`}
                {m.meta?.rating === "up" && " · 👍"}
                {m.meta?.rating === "down" && <span className="text-danger"> · 👎</span>}
                {m.meta?.fromSite && ` · ${t.inbox.fromSite}`}
              </div>
              {m.role === "assistant" && (m.meta?.trace || m.meta?.model) ? (
                <details className="mt-0.5 max-w-[85%] px-1 text-[11px] text-muted">
                  <summary className="cursor-pointer select-none">{t.inbox.trace}</summary>
                  <div className="mt-1 space-y-1 rounded-lg bg-surface-2/60 p-2 font-mono">
                    <div>
                      {m.meta.model} · {m.meta.ms ? `${(m.meta.ms / 1000).toFixed(1)} s` : "—"} · in {m.meta.inputTokens ?? 0} / out {m.meta.outputTokens ?? 0}
                      {m.meta.cost !== undefined && ` · $${m.meta.cost.toFixed(4)}`}
                      {m.meta.trace?.variant && ` · ${t.inbox.variant} ${m.meta.trace.variant}`}
                    </div>
                    {m.meta.kb?.sources.length ? <div>📚 {m.meta.kb.sources.join(", ")}</div> : null}
                    {m.meta.trace?.steps.map((st, i) => (
                      <div key={i} className={cx("border-l-2 pl-2", st.error ? "border-danger" : "border-accent/40")}>
                        <div className="font-semibold">
                          {i + 1}. {st.tool}({st.input})
                        </div>
                        <div className="whitespace-pre-wrap break-words">→ {st.result}</div>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
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
            </div>
          );
          })()}
          </Fragment>
        ))}
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
      <>
      <QuickReplies text={text} onPick={(q) => setText((v) => (v.trim() ? `${v.trimEnd()} ${q}` : q))} />
      <form
        className="flex items-end gap-2 p-3 pt-2"
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
        <Button
          type="button"
          variant="secondary"
          disabled={!text.trim() || checking}
          title={t.inbox.reviewCheck}
          onClick={() =>
            startCheck(async () => {
              const r = await checkOperatorDraft(data.id, text);
              setReview("error" in r ? null : r);
            })
          }
        >
          {checking ? <Spinner /> : <ShieldCheck className="size-4" />}
        </Button>
        <Button type="submit" disabled={!text.trim() || pending} title={t.inbox.send}>
          <SendHorizontal className="size-4" />
        </Button>
      </form>
      </>
      )}
      {review && (
        <div className="mx-3 mb-3 rounded-xl border border-border bg-surface-2/60 p-3 text-sm">
          <div className={cx("flex items-center gap-1.5 font-medium", review.score >= 8 ? "text-success" : review.score >= 6 ? "text-amber-600" : "text-danger")}>
            <ShieldCheck className="size-4" />
            {review.problems.length ? `${t.inbox.review}: ${review.score}/10` : `${t.inbox.reviewGood} · ${review.score}/10`}
            <button type="button" className="ml-auto text-muted hover:text-text" onClick={() => setReview(null)} aria-label="×">
              <X className="size-4" />
            </button>
          </div>
          {review.problems.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
              {review.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {review.better && (
            <div className="mt-2 rounded-lg bg-surface p-2.5">
              <div className="mb-1 text-xs font-medium text-muted">{t.inbox.reviewBetter}</div>
              <p className="whitespace-pre-wrap">{review.better}</p>
              <button type="button" className="mt-1.5 text-xs font-semibold text-accent hover:underline" onClick={() => setText(review.better)}>
                {t.inbox.reviewUse}
              </button>
            </div>
          )}
        </div>
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

const QUICK_KEY = "quick-replies";
const QUICK_EVENT = "genagent:quick";
const readQuick = () => {
  try {
    return localStorage.getItem(QUICK_KEY) ?? "";
  } catch {
    return "";
  }
};
const subscribeQuick = (onChange: () => void) => {
  window.addEventListener(QUICK_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(QUICK_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
};
function saveQuick(list: string[]) {
  try {
    localStorage.setItem(QUICK_KEY, JSON.stringify(list.slice(0, 12)));
  } catch {}
  window.dispatchEvent(new Event(QUICK_EVENT));
}

/**
 * Быстрые ответы менеджера над полем ввода: щелчок вставляет фразу. Свои фразы сохраняются в этом браузере
 * («+» — сохранить набранный текст, «×» у фразы — убрать); пока своих нет — стандартный набор.
 */
function QuickReplies({ text, onPick }: { text: string; onPick: (q: string) => void }) {
  const { t } = useI18n();
  const raw = useSyncExternalStore(subscribeQuick, readQuick, () => "");
  let list: string[];
  try {
    list = raw ? (JSON.parse(raw) as string[]) : t.shell.quickDefaults.split("|");
  } catch {
    list = t.shell.quickDefaults.split("|");
  }
  const draft = text.trim();
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-t border-border px-3 pt-2.5 [scrollbar-width:none]">
      {list.map((q) => (
        <span key={q} className="group/q relative inline-flex shrink-0 items-center">
          <button type="button" onClick={() => onPick(q)} title={q} className="max-w-56 truncate rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition hover:border-accent/50 hover:text-text">
            {q}
          </button>
          <button
            type="button"
            aria-label={t.shell.quickRemove}
            title={t.shell.quickRemove}
            onClick={() => saveQuick(list.filter((x) => x !== q))}
            className="absolute -top-1 -right-1 hidden size-4 place-items-center rounded-full bg-text text-[10px] leading-none text-bg group-hover/q:grid"
          >
            ×
          </button>
        </span>
      ))}
      {draft && !list.includes(draft) && (
        <button type="button" onClick={() => saveQuick([...list, draft])} title={t.shell.quickAdd} aria-label={t.shell.quickAdd} className="grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-border text-muted hover:border-accent hover:text-accent">
          +
        </button>
      )}
    </div>
  );
}
