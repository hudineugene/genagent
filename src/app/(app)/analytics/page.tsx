import Link from "next/link";
import { and, asc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, bookings, clients, conversations, messages, usageLog } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { monthStart } from "@/lib/usage";
import { studioTz } from "@/lib/general";
import { SortTh, byKey, readSort, type SortDir } from "@/components/sort-th";
import { findModel } from "@/lib/models";
import { Card, PageHeader, cx } from "@/components/ui";
import { AnalyticsCharts } from "./charts";
import { Heatmap } from "@/components/heatmap";
import { SectionTip } from "@/components/section-tip";
import { ClientSelect } from "@/components/client-select";
import { agentFunnels } from "@/lib/agent/funnel";
import { InfoHint } from "@/components/hint";
import { resolutionStats, sourceStats } from "@/lib/agent/resolution";
import { inScope, scope } from "@/lib/access";
import { jsonText } from "@/db/dialect";

const PERIODS = [7, 30, 90] as const;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string; client?: string; sort?: string; dir?: string }> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const days = PERIODS.find((d) => String(d) === sp.days) ?? 30;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  // Сотрудник с ограниченным доступом — аналитика по одному из своих клиентов
  const ids = await scope();
  const clientId = ids ? (sp.client && ids.includes(sp.client) ? sp.client : (ids[0] ?? "—")) : sp.client || null;

  // тестовые разговоры — не в счёт (расходы считаем все: деньги потрачены реально)
  const convWhere: SQL[] = [gte(conversations.createdAt, from), eq(conversations.isTest, false)];
  if (clientId) convWhere.push(eq(conversations.clientId, clientId));
  const usageWhere: SQL[] = [gte(usageLog.createdAt, from)];
  if (clientId) usageWhere.push(eq(usageLog.clientId, clientId));
  const msgWhere: SQL[] = [gte(messages.createdAt, from), eq(conversations.isTest, false)];
  if (clientId) msgWhere.push(eq(conversations.clientId, clientId));

  const day = (col: unknown) => sql<string>`date(${col} / 1000, 'unixepoch', 'localtime')`;

  const bookingWhere: SQL[] = [gte(bookings.createdAt, from)];
  if (clientId) bookingWhere.push(eq(bookings.clientId, clientId));

  const [clientList, [convTotals], [msgTotals], [usageTotals], convDaily, costDaily, bySource, byChannel, agentRows, agentUsage, monthUsage, [bookingTotals]] =
    await Promise.all([
      db.select({ id: clients.id, name: clients.name }).from(clients).where(inScope(clients.id, ids)).orderBy(asc(clients.name)),
      db.select({ n: sql<number>`count(*)` }).from(conversations).where(and(...convWhere)),
      db
        .select({
          user: sql<number>`sum(case when ${messages.role} = 'user' then 1 else 0 end)`,
          agent: sql<number>`sum(case when ${messages.role} = 'assistant' and ${messages.status} = 'sent' then 1 else 0 end)`,
          operator: sql<number>`sum(case when ${messages.role} = 'operator' then 1 else 0 end)`,
          handoffs: sql<number>`sum(case when ${messages.role} = 'system' and ${messages.text} = 'handoff' then 1 else 0 end)`,
          // Доля передач — по диалогам: в одном диалоге агент может передать клиента несколько раз
          handoffConvs: sql<number>`count(distinct case when ${messages.role} = 'system' and ${messages.text} = 'handoff' then ${messages.conversationId} end)`,
          activeConvs: sql<number>`count(distinct case when ${messages.role} = 'user' then ${messages.conversationId} end)`,
          avgMs: sql<number>`avg(case when ${messages.role} = 'assistant' then ${jsonText(messages.meta, "ms")} end)`,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(...msgWhere)),
      db
        .select({ cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)`, calls: sql<number>`count(*)` })
        .from(usageLog)
        .where(and(...usageWhere)),
      db
        .select({ d: day(conversations.createdAt), n: sql<number>`count(*)` })
        .from(conversations)
        .where(and(...convWhere))
        .groupBy(day(conversations.createdAt)),
      db
        .select({ d: day(usageLog.createdAt), cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
        .from(usageLog)
        .where(and(...usageWhere))
        .groupBy(day(usageLog.createdAt)),
      db
        .select({ source: usageLog.source, cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)`, calls: sql<number>`count(*)` })
        .from(usageLog)
        .where(and(...usageWhere))
        .groupBy(usageLog.source),
      db
        .select({ type: conversations.channelType, n: sql<number>`count(*)` })
        .from(conversations)
        .where(and(...convWhere))
        .groupBy(conversations.channelType),
      db
        .select({
          id: agents.id,
          name: agents.name,
          clientName: clients.name,
          config: agents.config,
          conversations: sql<number>`(select count(*) from conversations c where c.agent_id = ${agents.id} and c.is_test = 0 and c.created_at >= ${from.getTime()})`,
          replies: sql<number>`(select count(*) from messages m join conversations c on c.id = m.conversation_id where c.agent_id = ${agents.id} and c.is_test = 0 and m.role = 'assistant' and m.status = 'sent' and m.created_at >= ${from.getTime()})`,
          handoffs: sql<number>`(select count(*) from messages m join conversations c on c.id = m.conversation_id where c.agent_id = ${agents.id} and c.is_test = 0 and m.role = 'system' and m.text = 'handoff' and m.created_at >= ${from.getTime()})`,
        })
        .from(agents)
        .innerJoin(clients, eq(clients.id, agents.clientId))
        .where(clientId ? eq(agents.clientId, clientId) : undefined),
      db
        .select({ agentId: usageLog.agentId, cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
        .from(usageLog)
        .where(and(...usageWhere))
        .groupBy(usageLog.agentId),
      db
        .select({ agentId: usageLog.agentId, cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
        .from(usageLog)
        .where(gte(usageLog.createdAt, monthStart()))
        .groupBy(usageLog.agentId),
      db.select({ n: sql<number>`count(*)` }).from(bookings).where(and(...bookingWhere)),
    ]);
  const bookingCount = Number(bookingTotals?.n ?? 0);

  // Прошлый период той же длины — для сравнения на плитках («+24% к прошлым 30 дням»)
  const prevFrom = new Date(from);
  prevFrom.setDate(prevFrom.getDate() - days);
  const [[prevConv], [prevUsage], [prevMsg]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(conversations)
      .where(and(gte(conversations.createdAt, prevFrom), lt(conversations.createdAt, from), eq(conversations.isTest, false), clientId ? eq(conversations.clientId, clientId) : undefined)),
    db
      .select({ cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
      .from(usageLog)
      .where(and(gte(usageLog.createdAt, prevFrom), lt(usageLog.createdAt, from), clientId ? eq(usageLog.clientId, clientId) : undefined)),
    db
      .select({
        handoffConvs: sql<number>`count(distinct case when ${messages.role} = 'system' and ${messages.text} = 'handoff' then ${messages.conversationId} end)`,
        activeConvs: sql<number>`count(distinct case when ${messages.role} = 'user' then ${messages.conversationId} end)`,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(gte(messages.createdAt, prevFrom), lt(messages.createdAt, from), eq(conversations.isTest, false), clientId ? eq(conversations.clientId, clientId) : undefined)),
  ]);
  // Карта активности: сообщения клиентов по дням недели и часам (часовой пояс студии)
  const userTimes = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.role, "user"), ...msgWhere))
    .limit(100_000);
  const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", hourCycle: "h23", timeZone: studioTz() });
  const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  for (const { at } of userTimes) {
    const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]));
    heat[WD[p.weekday] ?? 0][Number(p.hour) % 24]++;
  }
  /** Изменение к прошлому периоду, %; нет данных за прошлый период — без сравнения. */
  const growth = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
  const vs = t.analytics.vsPrev.replace("{n}", String(days));

  // Ряды по дням без пропусков
  const fmtDay = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "short" });
  const keys: { key: string; label: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    keys.push({ key, label: fmtDay.format(d) });
  }
  const convMap = new Map(convDaily.map((r) => [r.d, Number(r.n)]));
  const costMap = new Map(costDaily.map((r) => [r.d, Number(r.cost)]));

  const usageByAgent = new Map(agentUsage.map((r) => [r.agentId, Number(r.cost)]));
  const monthByAgent = new Map(monthUsage.map((r) => [r.agentId, Number(r.cost)]));
  const totalConvs = Number(convTotals?.n ?? 0);
  const handoffs = Number(msgTotals?.handoffs ?? 0);
  const handoffConvs = Number(msgTotals?.handoffConvs ?? 0);
  // Диалоги, где клиент писал за период (передача без сообщения клиента в периоде тоже считается диалогом)
  const activeConvs = Math.max(Number(msgTotals?.activeConvs ?? 0), handoffConvs);
  const totalCost = Number(usageTotals?.cost ?? 0);
  const money = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);

  const agentSort = readSort(sp, ["agent", "conv", "replies", "handoffs", "resolved", "spend", "month"] as const, "spend");
  const sortHref = (s: string, d: SortDir) => qs({ sort: s, dir: d });
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { days: String(days), client: clientId ?? undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    return `/analytics?${p}`;
  };

  const funnels = (await agentFunnels(from.getTime())).filter((f) => !clientId || f.clientId === clientId);
  const [resolution, sources] = await Promise.all([resolutionStats(from, clientId), sourceStats(from, clientId)]);
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  // Задержка ответа агента: медиана и 95-й процентиль (по ответам за период)
  const times = (
    await db
      .select({ ms: sql<number>`${jsonText(messages.meta, "ms")}` })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(...msgWhere, eq(messages.role, "assistant"), sql`${jsonText(messages.meta, "ms")} is not null`))
      .limit(20000)
  )
    .map((r) => Number(r.ms))
    .sort((a, b) => a - b);
  const q = (p: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] / 1000 : null);
  const p50 = q(0.5);
  const p95 = q(0.95);
  const R = t.analytics.resolution;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t.analytics.title} />
      <SectionTip id="analytics" />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-surface-2 p-1">
          {PERIODS.map((d) => (
            <Link
              key={d}
              href={qs({ days: String(d) })}
              replace
              className={cx("rounded-lg px-3 py-1.5 text-sm font-medium transition", d === days ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
            >
              {t.analytics.days.replace("{n}", String(d))}
            </Link>
          ))}
        </div>
        {clientList.length > 1 && (
          <div className="ml-auto">
            <ClientSelect clients={clientList} />
          </div>
        )}
      </div>

      <AnalyticsCharts
        tiles={[
          { label: t.analytics.conversations, value: totalConvs.toLocaleString(), change: { pct: growth(totalConvs, Number(prevConv?.n ?? 0)), better: "up", label: vs } },
          {
            label: t.analytics.handoffRate,
            value: activeConvs ? `${Math.round((handoffConvs / activeConvs) * 100)}%` : "—",
            hint: t.analytics.handoffsIn.replace("{n}", String(handoffs)).replace("{c}", String(handoffConvs)),
            // Доля передач — разница в процентных пунктах
            change:
              activeConvs && Number(prevMsg?.activeConvs ?? 0)
                ? { pct: Math.round((handoffConvs / activeConvs) * 100 - (Number(prevMsg?.handoffConvs ?? 0) / Number(prevMsg?.activeConvs)) * 100), better: "down", label: vs, unit: t.analytics.pp }
                : undefined,
          },
          { label: t.analytics.avgResponse, value: p50 !== null ? `${p50.toFixed(1)} ${t.analytics.sec}` : "—", hint: p95 !== null ? `p50 · p95 ${p95.toFixed(1)} ${t.analytics.sec}` : undefined },
          { label: t.analytics.spend, value: money(totalCost), hint: totalConvs ? `${money(totalCost / totalConvs)} ${t.analytics.perConversation}` : undefined, change: { pct: growth(totalCost, Number(prevUsage?.cost ?? 0)), better: "down", label: vs } },
        ]}
        extra={[
          `${t.analytics.agentReplies}: ${Number(msgTotals?.agent ?? 0).toLocaleString()}`,
          `${t.analytics.operatorReplies}: ${Number(msgTotals?.operator ?? 0)}`,
          `${Number(usageTotals?.calls ?? 0)} ${t.analytics.calls}`,
          // Записи — только когда агенты уже записывают клиентов в календарь.
          ...(bookingCount ? [`${t.analytics.bookings}: ${bookingCount.toLocaleString()}`] : []),
        ]}
        conversations={keys.map((k) => ({ key: k.key, label: k.label, value: convMap.get(k.key) ?? 0 }))}
        costs={keys.map((k) => ({ key: k.key, label: k.label, value: Math.round((costMap.get(k.key) ?? 0) * 1000) / 1000 }))}
      />

      {heat.some((row) => row.some(Boolean)) && (
      <Card className="p-5">
        <Heatmap grid={heat} days={t.analytics.weekdaysShort} title={t.analytics.heatTitle} hint={t.analytics.heatHint} peakLabel={t.analytics.heatPeak} less={t.analytics.heatLess} more={t.analytics.heatMore} unit={t.analytics.heatUnit} />
      </Card>
      )}

      {resolution.all.total > 0 && (
        <Card className="space-y-4 p-5">
          <h3 className="flex items-center gap-1 text-sm font-semibold">
            {R.title}
            <InfoHint>{R.hint}</InfoHint>
          </h3>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <div className="text-3xl font-semibold text-accent">{pct(resolution.all.rate)}</div>
              <div className="text-xs text-muted">{R.rate}</div>
            </div>
            {(["confirmed", "assumed", "returned", "escalated", "open"] as const).map((k) => (
              <div key={k} title={R.hints[k]}>
                <div className="text-xl font-semibold tabular-nums">{resolution.all[k]}</div>
                <div className="text-xs text-muted">{R.labels[k]}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {funnels.length > 0 && (
        <Card className="space-y-4 p-5">
          <h3 className="flex items-center gap-1 text-sm font-semibold">
            {t.analytics.funnelTitle}
            <InfoHint>{t.analytics.funnelHint}</InfoHint>
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {funnels.map((f) => (
              <div key={f.agentId} className="space-y-2 rounded-xl border border-border p-4 text-sm">
                <div className="font-medium">{f.title}</div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted">{t.analytics.funnelTalked}</span>
                  <b>{f.talked}</b>
                </div>
                {f.steps.length > 0 &&
                  f.steps.map((s) => (
                    <div key={s.type} className="flex items-baseline justify-between gap-2">
                      <span className="text-muted">{s.label}</span>
                      <span>
                        <b>{s.total}</b>
                        {s.assisted > 0 && <span className="text-xs text-muted"> · {t.analytics.funnelAfterAgent} {s.assisted}</span>}
                        {s.value > 0 && <span className="text-xs text-muted"> · {Math.round(s.value).toLocaleString()}</span>}
                      </span>
                    </div>
                  ))}
                {f.talked > 0 && f.steps.length > 0 && (
                  <div className="flex items-baseline justify-between gap-2 border-t border-border pt-2">
                    <span className="text-muted">{t.analytics.funnelConversion}</span>
                    <b className="text-accent">{Math.round((f.converted / f.talked) * 100)}%</b>
                  </div>
                )}
                {(f.ratingUp > 0 || f.ratingDown > 0) && (
                  <div className="text-xs text-muted">
                    {t.analytics.funnelRatings}: 👍 {f.ratingUp} · 👎 {f.ratingDown}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <Card className="overflow-x-auto p-5">
          <h3 className="mb-3 text-sm font-semibold">{t.analytics.byAgent}</h3>
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <SortTh label={t.analytics.agent} col="agent" {...agentSort} href={sortHref} />
                <SortTh label={t.analytics.conversations} col="conv" {...agentSort} href={sortHref} align="right" />
                <SortTh label={t.analytics.agentReplies} col="replies" {...agentSort} href={sortHref} align="right" />
                <SortTh label={t.analytics.handoffs} col="handoffs" {...agentSort} href={sortHref} align="right" />
                <SortTh label={R.short} col="resolved" {...agentSort} href={sortHref} align="right" />
                <SortTh label={t.analytics.spend} col="spend" {...agentSort} href={sortHref} align="right" />
                <SortTh label={t.analytics.monthBudget} col="month" {...agentSort} href={sortHref} align="right" className="pr-0" />
              </tr>
            </thead>
            <tbody>
              {agentRows
                .sort(
                  byKey(
                    (a) =>
                      ({
                        agent: a.name,
                        conv: Number(a.conversations),
                        replies: Number(a.replies),
                        handoffs: Number(a.handoffs),
                        resolved: resolution.byAgent.get(a.id)?.rate ?? -1,
                        spend: usageByAgent.get(a.id) ?? 0,
                        month: monthByAgent.get(a.id) ?? 0,
                      })[agentSort.sort],
                    agentSort.dir,
                  ),
                )
                .map((a) => {
                  const cfg = a.config as { icon?: string; model?: string; monthlyBudgetUsd?: number | null };
                  const month = monthByAgent.get(a.id) ?? 0;
                  const budget = cfg.monthlyBudgetUsd ?? null;
                  const over = budget !== null && month >= budget;
                  return (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3">
                        <Link href={`/agents/${a.id}`} className="hover:text-accent">
                          {cfg.icon} {a.name}
                        </Link>
                        <div className="text-xs text-muted">
                          {a.clientName} · {findModel(cfg.model ?? "")?.label ?? cfg.model}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{Number(a.conversations)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{Number(a.replies)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{Number(a.handoffs)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pct(resolution.byAgent.get(a.id)?.rate ?? null)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(usageByAgent.get(a.id) ?? 0)}</td>
                      <td className={cx("py-2 text-right tabular-nums", over && "font-semibold text-danger")}>
                        {money(month)}
                        {budget !== null && <span className="text-muted"> / {money(budget)}</span>}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </Card>

        <div className="space-y-6">
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold">{t.analytics.byChannel}</h3>
            {byChannel.length === 0 ? (
              <p className="text-sm text-muted">—</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {byChannel
                    .sort((a, b) => Number(b.n) - Number(a.n))
                    .map((c) => (
                      <tr key={c.type} className="border-b border-border last:border-0">
                        <td className="py-1.5">{t.analytics.channels[c.type]}</td>
                        <td className="py-1.5 text-right tabular-nums">{Number(c.n)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Card>
          {sources.some((s) => s.kind !== "direct") && (
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-1 text-sm font-semibold">
                {R.sourcesTitle}
                <InfoHint>{R.sourcesHint}</InfoHint>
              </h3>
              <table className="w-full text-sm">
                <tbody>
                  {sources
                    .sort((a, b) => b.conversations - a.conversations)
                    .map((s) => (
                      <tr key={`${s.kind}:${s.title}`} className="border-b border-border last:border-0">
                        <td className="py-1.5">
                          {R.kinds[s.kind as keyof typeof R.kinds] ?? s.kind}
                          {s.title && <span className="text-muted"> · {s.title}</span>}
                          {s.paid > 0 && <div className="text-xs text-success">💳 {s.paid} · {s.revenue}</div>}
                        </td>
                        <td className="py-1.5 text-right align-top tabular-nums">{s.conversations}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          )}
          <Card className="p-5">
            <h3 className="mb-3 text-sm font-semibold">{t.analytics.bySource}</h3>
            {bySource.length === 0 ? (
              <p className="text-sm text-muted">—</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {bySource
                    .sort((a, b) => Number(b.cost) - Number(a.cost))
                    .map((s) => (
                      <tr key={s.source} className="border-b border-border last:border-0">
                        <td className="py-1.5">
                          {t.analytics.sources[s.source]}
                          <span className="ml-1 text-xs text-muted">({Number(s.calls)})</span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{money(Number(s.cost))}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
            <p className="mt-3 text-xs text-muted">{t.analytics.costNote}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

export const instant = false;
