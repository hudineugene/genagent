import Link from "next/link";
import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agents, bookings, clients, conversations, messages, usageLog } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { monthStart } from "@/lib/usage";
import { findModel } from "@/lib/models";
import { Card, PageHeader, cx } from "@/components/ui";
import { AnalyticsCharts } from "./charts";
import { agentFunnels } from "@/lib/agent/funnel";

const PERIODS = [7, 30, 90] as const;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string; client?: string }> }) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const days = PERIODS.find((d) => String(d) === sp.days) ?? 30;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  const clientId = sp.client || null;

  const convWhere: SQL[] = [gte(conversations.createdAt, from)];
  if (clientId) convWhere.push(eq(conversations.clientId, clientId));
  const usageWhere: SQL[] = [gte(usageLog.createdAt, from)];
  if (clientId) usageWhere.push(eq(usageLog.clientId, clientId));
  const msgWhere: SQL[] = [gte(messages.createdAt, from)];
  if (clientId) msgWhere.push(eq(conversations.clientId, clientId));

  const day = (col: unknown) => sql<string>`date(${col} / 1000, 'unixepoch', 'localtime')`;

  const bookingWhere: SQL[] = [gte(bookings.createdAt, from)];
  if (clientId) bookingWhere.push(eq(bookings.clientId, clientId));

  const [clientList, [convTotals], [msgTotals], [usageTotals], convDaily, costDaily, bySource, byChannel, agentRows, agentUsage, monthUsage, [bookingTotals]] =
    await Promise.all([
      db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name)),
      db.select({ n: sql<number>`count(*)` }).from(conversations).where(and(...convWhere)),
      db
        .select({
          user: sql<number>`sum(case when ${messages.role} = 'user' then 1 else 0 end)`,
          agent: sql<number>`sum(case when ${messages.role} = 'assistant' and ${messages.status} = 'sent' then 1 else 0 end)`,
          operator: sql<number>`sum(case when ${messages.role} = 'operator' then 1 else 0 end)`,
          handoffs: sql<number>`sum(case when ${messages.role} = 'system' and ${messages.text} = 'handoff' then 1 else 0 end)`,
          avgMs: sql<number>`avg(case when ${messages.role} = 'assistant' then json_extract(${messages.meta}, '$.ms') end)`,
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
          conversations: sql<number>`(select count(*) from conversations c where c.agent_id = ${agents.id} and c.created_at >= ${from.getTime()})`,
          replies: sql<number>`(select count(*) from messages m join conversations c on c.id = m.conversation_id where c.agent_id = ${agents.id} and m.role = 'assistant' and m.status = 'sent' and m.created_at >= ${from.getTime()})`,
          handoffs: sql<number>`(select count(*) from messages m join conversations c on c.id = m.conversation_id where c.agent_id = ${agents.id} and m.role = 'system' and m.text = 'handoff' and m.created_at >= ${from.getTime()})`,
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
  const totalCost = Number(usageTotals?.cost ?? 0);
  const money = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { days: String(days), client: clientId ?? undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    return `/analytics?${p}`;
  };

  const funnels = (await agentFunnels(from.getTime())).filter((f) => !clientId || f.clientId === clientId);
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t.analytics.title} subtitle={t.analytics.subtitle} />

      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((d) => (
          <Link
            key={d}
            href={qs({ days: String(d) })}
            replace
            className={cx("rounded-full px-3 py-1.5 text-sm", d === days ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text")}
          >
            {t.analytics.days.replace("{n}", String(d))}
          </Link>
        ))}
        {clientList.length > 1 && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Link
              href={qs({ client: undefined })}
              replace
              className={cx("rounded-full px-3 py-1.5 text-sm", !clientId ? "bg-accent-soft text-accent" : "text-muted hover:text-text")}
            >
              {t.inbox.allClients}
            </Link>
            {clientList.map((c) => (
              <Link
                key={c.id}
                href={qs({ client: c.id })}
                replace
                className={cx(
                  "max-w-48 truncate rounded-full px-3 py-1.5 text-sm",
                  clientId === c.id ? "bg-accent-soft text-accent" : "text-muted hover:text-text",
                )}
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <AnalyticsCharts
        tiles={[
          { label: t.analytics.conversations, value: totalConvs.toLocaleString() },
          { label: t.analytics.agentReplies, value: Number(msgTotals?.agent ?? 0).toLocaleString(), hint: `${t.analytics.operatorReplies}: ${Number(msgTotals?.operator ?? 0)}` },
          {
            label: t.analytics.handoffRate,
            value: totalConvs ? `${Math.round((handoffs / totalConvs) * 100)}%` : "—",
            hint: `${handoffs} ${t.analytics.handoffs}`,
          },
          { label: t.analytics.avgResponse, value: msgTotals?.avgMs ? `${(Number(msgTotals.avgMs) / 1000).toFixed(1)} ${t.analytics.sec}` : "—" },
          { label: t.analytics.spend, value: money(totalCost), hint: `${Number(usageTotals?.calls ?? 0)} ${t.analytics.calls}` },
          { label: t.analytics.costPerConversation, value: totalConvs ? money(totalCost / totalConvs) : "—" },
          // Плитка записей — только когда агенты уже записывают клиентов в календарь.
          ...(bookingCount ? [{ label: t.analytics.bookings, value: bookingCount.toLocaleString(), hint: t.analytics.bookingsHint }] : []),
        ]}
        conversations={keys.map((k) => ({ key: k.key, label: k.label, value: convMap.get(k.key) ?? 0 }))}
        costs={keys.map((k) => ({ key: k.key, label: k.label, value: Math.round((costMap.get(k.key) ?? 0) * 1000) / 1000 }))}
      />

      {funnels.length > 0 && (
        <Card className="space-y-4 p-5">
          <div>
            <h3 className="text-sm font-semibold">{t.analytics.funnelTitle}</h3>
            <p className="text-xs text-muted">{t.analytics.funnelHint}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {funnels.map((f) => (
              <div key={f.agentId} className="space-y-2 rounded-xl border border-border p-4 text-sm">
                <div className="font-medium">{f.title}</div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted">{t.analytics.funnelTalked}</span>
                  <b>{f.talked}</b>
                </div>
                {f.steps.length ? (
                  f.steps.map((s) => (
                    <div key={s.type} className="flex items-baseline justify-between gap-2">
                      <span className="text-muted">{s.label}</span>
                      <span>
                        <b>{s.total}</b>
                        {s.assisted > 0 && <span className="text-xs text-muted"> · {t.analytics.funnelAfterAgent} {s.assisted}</span>}
                        {s.value > 0 && <span className="text-xs text-muted"> · {Math.round(s.value).toLocaleString()}</span>}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted">{t.analytics.funnelNoEvents}</p>
                )}
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

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card className="overflow-x-auto p-5">
          <h3 className="mb-3 text-sm font-semibold">{t.analytics.byAgent}</h3>
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">{t.analytics.agent}</th>
                <th className="py-2 pr-3 text-right font-medium">{t.analytics.conversations}</th>
                <th className="py-2 pr-3 text-right font-medium">{t.analytics.agentReplies}</th>
                <th className="py-2 pr-3 text-right font-medium">{t.analytics.handoffs}</th>
                <th className="py-2 pr-3 text-right font-medium">{t.analytics.spend}</th>
                <th className="py-2 text-right font-medium">{t.analytics.monthBudget}</th>
              </tr>
            </thead>
            <tbody>
              {agentRows
                .sort((a, b) => (usageByAgent.get(b.id) ?? 0) - (usageByAgent.get(a.id) ?? 0) || b.conversations - a.conversations)
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
