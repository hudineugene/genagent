import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import {
  ArrowRight,
  CircleDollarSign,
  CircleHelp,
  Clock,
  Flame,
  Hand,
  MessagesSquare,
  Radio,
  RefreshCwOff,
  Sparkles,
  UserRound,
  Wallet,
} from "lucide-react";
import { getT } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n";
import { scope } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { dashboardData, type Decision } from "@/lib/dashboard";
import { ClientCard } from "@/components/client-card";
import { contactLabel } from "@/lib/contact";
import { Card, EmptyState, cx } from "@/components/ui";
import { SetupChecklist } from "@/components/setup-checklist";
import { setupChecklist } from "@/lib/setup-checklist";
import { studioTz } from "@/lib/general";
import { homeFeed, homeTrends, type FeedItem } from "@/lib/home-live";
import { Spark } from "@/components/spark";
import { AutoRefresh } from "@/components/auto-refresh";
import { RelTime } from "@/components/rel-time";
import { CountUp } from "@/components/count-up";
import { daySummary } from "@/lib/day-summary";

/** Главная «Сегодня»: кто ждёт человека, что требует решения, сводка за сутки и клиенты. */
export default async function TodayPage() {
  const { t, locale } = await getT();
  const ids = await scope();
  const [data, setup, trends, feed] = await Promise.all([dashboardData(ids), setupChecklist(undefined, ids), homeTrends(ids), homeFeed(ids)]);
  const { today, waiting, decisions } = data;
  const gaps = decisions.filter((d): d is Extract<Decision, { kind: "gaps" }> => d.kind === "gaps");
  const decisionRows = decisions.length - gaps.length + (gaps.length ? 1 : 0);
  const date = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: studioTz() }).format(new Date());
  // Приветствие по времени студии и имени сотрудника
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: studioTz() }).format(new Date()));
  const hello = hour >= 5 && hour < 12 ? t.home.helloMorning : hour < 17 && hour >= 12 ? t.home.helloDay : hour < 23 && hour >= 17 ? t.home.helloEvening : t.home.helloNight;
  const firstName = (await requireUser()).name.trim().split(/\s+/)[0];
  const share = today.wrote ? Math.round((today.answered / today.wrote) * 100) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted first-letter:uppercase">{date}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            {hello}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {waiting.length || decisionRows
              ? t.home.focus.replace("{w}", String(waiting.length)).replace("{d}", String(decisionRows))
              : t.home.focusCalm}
          </p>
        </div>
        {share !== null && <Ring value={share} label={t.home.ringLabel} />}
      </header>

      <Suspense fallback={null}>
        <DaySummaryCard ids={ids} locale={locale} title={t.home.daySummary} />
      </Suspense>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<MessagesSquare className="size-4" />} label={t.home.statWrote} value={today.wrote} sub={`${today.answered} ${t.home.statAnswered}`} trend={trends.wrote} />
        <Stat
          icon={<Clock className="size-4" />}
          label={t.home.statWaiting}
          value={waiting.length}
          tone={waiting.length ? "danger" : "neutral"}
          href="/inbox"
        />
        <Stat icon={<Hand className="size-4" />} label={t.home.statHandoffs} value={today.handoffs} trend={trends.handoffs} />
        <Stat
          icon={<Wallet className="size-4" />}
          label={t.home.statSpendDay}
          value={`$${today.spendDay.toFixed(2)}`}
          sub={`$${today.spendMonth.toFixed(2)} ${t.home.statSpendMonth}`}
          href="/analytics"
          trend={trends.spend}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="overflow-hidden lg:col-span-3">
          <SectionHead title={t.home.waitingTitle} count={waiting.length} tone="danger" link={{ href: "/inbox", label: t.home.waitingAll }} />
          {waiting.length === 0 ? (
            <EmptyState icon={<Sparkles />} tone="success" text={t.home.waitingEmpty} className="rounded-none border-0" />
          ) : (
            <ul className="divide-y divide-border">
              {waiting.slice(0, 6).map((w) => (
                <li key={w.id}>
                  <Link href={`/inbox?c=${w.id}`} className="flex items-center gap-3 px-5 py-3 transition hover:bg-surface-2/60">
                    {w.name || w.handle ? (
                      <span className="grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: w.color }}>
                        {(w.name || w.handle).replace(/^@/, "").charAt(0).toUpperCase()}
                      </span>
                    ) : (
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                        <UserRound className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-semibold">{contactLabel({ contactName: w.name, contactHandle: w.handle, channelType: w.channelType, id: w.id }, t.inbox)}</span>
                        <span className="truncate text-xs text-muted" title={`${w.client} · ${w.agent}`}>
                          {w.client}
                          {w.mode === "human" && ` · ${t.home.managerMode}`}
                        </span>
                        {w.upset && <span className="shrink-0 text-[11px]" title={t.home.upset}>🔴</span>}
                      </span>
                      <span className="block truncate text-sm text-muted">{w.preview}</span>
                    </span>
                    <RelTime at={w.at} className="shrink-0 text-xs font-medium text-muted tabular-nums" />
                  </Link>
                </li>
              ))}
              {waiting.length > 6 && (
                <li>
                  <Link href="/inbox" className="block px-5 py-2.5 text-center text-sm font-medium text-accent hover:bg-surface-2/60">
                    {t.home.waitingAll} · {waiting.length}
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card className="self-start overflow-hidden lg:col-span-2">
          <SectionHead title={t.home.decisionsTitle} count={decisionRows} tone="accent" />
          {decisions.length === 0 ? (
            <EmptyState icon={<Sparkles />} tone="success" text={t.home.decisionsEmpty} className="rounded-none border-0" />
          ) : (
            <ul className="divide-y divide-border">
              {gaps.length > 0 && (
                <li>
                  <GapsRow gaps={gaps} t={t} />
                </li>
              )}
              {decisions
                .filter((d) => d.kind !== "gaps")
                .map((d, i) => (
                  <li key={i}>
                    <DecisionRow d={d} t={t} />
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <Card className="overflow-hidden">
          <SectionHead title={t.home.feedTitle} count={0} tone="accent" />
          <AutoRefresh seconds={30} />
          {feed.length === 0 ? (
            <EmptyState icon={<Radio />} text={t.home.feedEmpty} className="rounded-none border-0" />
          ) : (
            <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-2">
              {feed.map((f, i) => (
                <li key={`${f.kind}-${f.conversationId}-${f.at}-${i}`} className="sm:border-b sm:border-border sm:odd:border-r">
                  <FeedRow f={f} t={t} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {setup.length > 0 && (
        <section>
          <SetupChecklist items={setup.map(({ key, kind, title, n, href }) => ({ key, kind, title, n, href }))} />
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">{t.home.clientsTitle}</h2>
          <Link href="/clients" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
            {t.home.clientsAll}
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.clients.map((c) => (
            <ClientCard key={c.id} client={c} t={t} trend={trends.byClient[c.id]} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
  href,
  trend,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "neutral" | "danger";
  href?: string;
  /** Ряд за 14 дней — мини-график и стрелка тренда */
  trend?: number[];
}) {
  const body = (
    <Card className={cx("h-full p-4 transition", tone === "danger" ? "border-danger/30 bg-danger/[0.04]" : "bg-metal", href && "hover:border-accent/40 hover:shadow-md hover:shadow-black/5")}>
      <div className={cx("flex items-center gap-1.5 text-xs font-medium text-muted", tone === "danger" && "text-danger")}>
        <span className="opacity-70 [&>svg]:size-3.5">{icon}</span>
        {label}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className={cx("font-display text-2xl font-bold tracking-tight tabular-nums", tone === "danger" && "text-danger")}>{typeof value === "string" || typeof value === "number" ? <CountUp value={value} /> : value}</div>
        <span className="hidden sm:block">
          <Spark data={trend} wide height={22} />
        </span>
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** Строка живой ленты: что случилось, у кого и когда. */
function FeedRow({ f, t }: { f: FeedItem; t: Dict }) {
  const look = {
    new: { icon: <MessagesSquare className="size-4" />, cls: "bg-accent-soft text-accent", text: t.home.feedNew },
    handoff: { icon: <Hand className="size-4" />, cls: "bg-amber-500/12 text-amber-600 dark:text-amber-400", text: t.home.feedHandoff },
    hot: { icon: <Flame className="size-4" />, cls: "bg-danger/10 text-danger", text: t.home.feedHot },
    paid: { icon: <CircleDollarSign className="size-4" />, cls: "bg-success/10 text-success", text: t.home.feedPaid },
    mention: { icon: <MessagesSquare className="size-4" />, cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400", text: t.inbox.team.mentioned },
  }[f.kind];
  const body = (
    <span className="flex items-center gap-3 px-5 py-3">
      <span className={cx("grid size-9 shrink-0 place-items-center rounded-xl", look.cls)}>{look.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {look.text}
          {f.amount ? ` · ${f.amount}` : f.contact ? ` · ${f.contact}` : ""}
        </span>
        <span className="flex items-center gap-1.5 truncate text-xs text-muted">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: f.color }} />
          {f.client}
        </span>
      </span>
      <RelTime at={f.at} className="shrink-0 text-xs text-muted" />
    </span>
  );
  return f.conversationId ? (
    <Link href={`/inbox?c=${f.conversationId}`} className="block transition hover:bg-surface-2/60">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Сводка дня от ИИ (если включена в «Общих настройках»): грузится отдельно, страница её не ждёт. */
async function DaySummaryCard({ ids, locale, title }: { ids: string[] | null; locale: string; title: string }) {
  const text = await daySummary(ids, locale).catch(() => null);
  if (!text) return null;
  return (
    <section className="animate-page-in relative overflow-hidden rounded-2xl border border-accent/25 bg-accent-soft/50 px-5 py-4">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-accent">
        <Sparkles className="size-4" />
        {title}
      </div>
      <p className="text-sm leading-relaxed whitespace-pre-line">{text}</p>
    </section>
  );
}

/** Кольцо доли: скольким разговорам за сутки ответил агент. */
function Ring({ value, label }: { value: number; label: string }) {
  const r = 26;
  const len = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-metal px-4 py-3">
      <svg width={64} height={64} viewBox="0 0 64 64" className="-rotate-90" aria-hidden>
        <circle cx={32} cy={32} r={r} fill="none" strokeWidth={6} className="stroke-border" />
        <circle cx={32} cy={32} r={r} fill="none" strokeWidth={6} strokeLinecap="round" className="stroke-accent" strokeDasharray={`${(len * value) / 100} ${len}`} />
      </svg>
      <div>
        <div className="font-display text-2xl font-bold tabular-nums">{value}%</div>
        <div className="max-w-36 text-xs leading-snug text-muted">{label}</div>
      </div>
    </div>
  );
}

function SectionHead({ title, count, tone, link }: { title: string; count: number; tone: "danger" | "accent"; link?: { href: string; label: string } }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
      <h2 className="min-w-0 truncate font-semibold tracking-tight">{title}</h2>
      {count > 0 && (
        <span className={cx("rounded-full px-2 text-xs leading-5 font-semibold", tone === "danger" ? "bg-danger text-on-danger" : "bg-accent-soft text-accent")}>{count}</span>
      )}
      {link && (
        <Link href={link.href} className="ml-auto inline-flex shrink-0 items-center gap-1 text-sm font-medium whitespace-nowrap text-accent hover:underline">
          {link.label}
          <ArrowRight className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

function DecisionRow({ d, t }: { d: Decision; t: Dict }) {
  const row = (href: string, icon: ReactNode, iconClass: string, title: ReactNode, sub: string) => (
    <Link href={href} className="group flex items-center gap-3 px-5 py-3 transition hover:bg-surface-2/60">
      <span className={cx("grid size-9 shrink-0 place-items-center rounded-xl", iconClass)}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted">{sub}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </Link>
  );
  if (d.kind === "review") {
    return row(`/agents/${d.agentId}/review`, <Sparkles className="size-4" />, "bg-accent-soft text-accent", <>{t.home.decisionReview} <Count n={d.count} /></>, `${d.client} · ${d.agent}`);
  }
  if (d.kind === "gaps") {
    return row(`/agents/${d.agentId}/gaps`, <CircleHelp className="size-4" />, "bg-amber-500/12 text-amber-600 dark:text-amber-400", <>{t.home.decisionGaps} <Count n={d.count} /></>, `${d.client} · ${d.agent}`);
  }
  if (d.kind === "budget") {
    return row(`/agents/${d.agentId}`, <CircleDollarSign className="size-4" />, "bg-danger/10 text-danger", <>{t.home.decisionBudget}: ${d.spent.toFixed(2)} / ${d.limit}</>, `${d.client} · ${d.agent}`);
  }
  return row(`/clients/${d.clientId}?tab=kb`, <RefreshCwOff className="size-4" />, "bg-danger/10 text-danger", <>{t.home.decisionSync}{d.days ? ` · ${d.days} ${t.home.decisionSyncDays}` : ""}</>, `${d.client} · ${d.channel}`);
}

/** Вопросы без ответа у всех агентов — одной строкой: всего и ссылки по клиентам. */
function GapsRow({ gaps, t }: { gaps: Extract<Decision, { kind: "gaps" }>[]; t: Dict }) {
  const total = gaps.reduce((n, g) => n + g.count, 0);
  return (
    <div className="flex items-start gap-3 px-5 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
        <CircleHelp className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {t.home.decisionGaps} <Count n={total} />
        </span>
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {gaps.map((g) => (
            <Link
              key={g.agentId}
              href={`/agents/${g.agentId}/gaps`}
              title={g.agent}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted transition hover:border-accent/40 hover:text-accent"
            >
              {g.client}
              <b className="font-semibold text-text tabular-nums">{g.count}</b>
            </Link>
          ))}
        </span>
      </span>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-px text-xs font-semibold tabular-nums">{n}</span>;
}


// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
