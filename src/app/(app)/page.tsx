import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CircleDollarSign,
  CircleHelp,
  Clock,
  Hand,
  MessagesSquare,
  RefreshCwOff,
  Sparkles,
  UserRound,
  Wallet,
} from "lucide-react";
import { getT } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n";
import { scope } from "@/lib/access";
import { dashboardData, type Decision } from "@/lib/dashboard";
import { ClientCard } from "@/components/client-card";
import { contactLabel } from "@/lib/contact";
import { Card, EmptyState, cx } from "@/components/ui";
import { SetupChecklist } from "@/components/setup-checklist";
import { setupChecklist } from "@/lib/setup-checklist";

/** Главная «Сегодня»: кто ждёт человека, что требует решения, сводка за сутки и клиенты. */
export default async function TodayPage() {
  const { t, locale } = await getT();
  const ids = await scope();
  const [data, setup] = await Promise.all([dashboardData(ids), setupChecklist(undefined, ids)]);
  const { today, waiting, decisions } = data;
  const gaps = decisions.filter((d): d is Extract<Decision, { kind: "gaps" }> => d.kind === "gaps");
  const decisionRows = decisions.length - gaps.length + (gaps.length ? 1 : 0);
  const date = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Kyiv" }).format(new Date());

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <p className="text-sm font-medium text-muted first-letter:uppercase">{date}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t.home.title}</h1>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={<MessagesSquare className="size-4" />} label={t.home.statWrote} value={today.wrote} sub={`${today.answered} ${t.home.statAnswered}`} />
        <Stat
          icon={<Clock className="size-4" />}
          label={t.home.statWaiting}
          value={waiting.length}
          tone={waiting.length ? "danger" : "neutral"}
          href="/inbox"
        />
        <Stat icon={<Hand className="size-4" />} label={t.home.statHandoffs} value={today.handoffs} />
        <Stat
          icon={<Wallet className="size-4" />}
          label={t.home.statSpendDay}
          value={`$${today.spendDay.toFixed(2)}`}
          sub={`$${today.spendMonth.toFixed(2)} ${t.home.statSpendMonth}`}
          href="/analytics"
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
                    <span className="shrink-0 text-xs font-medium text-muted tabular-nums">{ago(w.at, t)}</span>
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
            <ClientCard key={c.id} client={c} t={t} />
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
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "neutral" | "danger";
  href?: string;
}) {
  const body = (
    <Card className={cx("h-full p-4 transition", href && "hover:border-accent/40 hover:shadow-md hover:shadow-black/5", tone === "danger" && "border-danger/30 bg-danger/[0.04]")}>
      <div className={cx("flex items-center gap-1.5 text-xs font-medium text-muted", tone === "danger" && "text-danger")}>
        <span className="opacity-70 [&>svg]:size-3.5">{icon}</span>
        {label}
      </div>
      <div className={cx("mt-2 text-2xl font-semibold tracking-tight tabular-nums", tone === "danger" && "text-danger")}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function SectionHead({ title, count, tone, link }: { title: string; count: number; tone: "danger" | "accent"; link?: { href: string; label: string } }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
      <h2 className="min-w-0 truncate font-semibold tracking-tight">{title}</h2>
      {count > 0 && (
        <span className={cx("rounded-full px-2 text-xs leading-5 font-semibold", tone === "danger" ? "bg-danger text-white" : "bg-accent-soft text-accent")}>{count}</span>
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

function ago(at: Date, t: Dict) {
  const min = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (min < 1) return t.home.justNow;
  if (min < 60) return `${min} ${t.home.minutes}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${t.home.hours}`;
  return `${Math.floor(h / 24)} ${t.home.days}`;
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
