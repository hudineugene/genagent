import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import { MessagesSquare } from "lucide-react";
import { db } from "@/db";
import { agents, channels, clients, conversations, knowledgeGaps, usageLog } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { getAgentReview } from "@/lib/agent/review";
import { findModel } from "@/lib/models";
import type { AgentConfig } from "@/lib/agent/types";
import { cx } from "@/components/ui";
import { AgentTabs } from "./tabs";

/**
 * Общая шапка всех вкладок агента: путь «Клиенты › клиент», иконка, название, статус, модель, короткая сводка
 * и вкладки. Одна на все вкладки — при переключении ничего не прыгает.
 */
export default async function AgentLayout({ children, params }: { children: ReactNode; params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const { t } = await getT();
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name, clientColor: clients.color })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();
  const { agent } = row;
  const config = agent.config as AgentConfig;
  const { week, monthStart } = periods();

  const [[{ n: channelCount }], [{ n: gaps }], [stats], [{ spend }], review] = await Promise.all([
    db.select({ n: count() }).from(channels).where(eq(channels.agentId, agentId)),
    db.select({ n: count() }).from(knowledgeGaps).where(and(eq(knowledgeGaps.agentId, agentId), eq(knowledgeGaps.status, "open"))),
    db
      .select({
        week: sql<number>`coalesce(sum(case when ${conversations.lastMessageAt} > ${week.getTime()} then 1 end), 0)`,
        waiting: sql<number>`coalesce(sum(case when ${conversations.needsAttention} = 1 then 1 end), 0)`,
      })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), ne(conversations.status, "closed"))),
    db.select({ spend: sql<number>`coalesce(sum(${usageLog.cost}), 0)` }).from(usageLog).where(and(eq(usageLog.agentId, agentId), gt(usageLog.createdAt, monthStart))),
    getAgentReview(agentId),
  ]);
  const proposals = review?.proposals.filter((p) => p.status === "new").length ?? 0;
  const model = findModel(config.model)?.label ?? config.model.split(":").pop();

  return (
    <div className="mx-auto max-w-[1400px]">
      <header className="mb-6 border-b border-border">
        <nav className="mb-3 flex items-center gap-1 text-sm text-muted">
          <Link href={`/clients/${row.clientId}`} className="flex min-w-0 items-center gap-1.5 hover:text-text">
            <span className="size-2 shrink-0 rounded-full" style={{ background: row.clientColor }} />
            <span className="truncate">{row.clientName}</span>
          </Link>
        </nav>
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-surface-2 text-2xl">{config.icon || "🤖"}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="truncate text-xl font-semibold tracking-tight">{agent.name}</h1>
                <span
                  className={cx(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                    agent.status === "active" ? "bg-success/12 text-success" : agent.status === "paused" ? "bg-amber-500/12 text-amber-600 dark:text-amber-400" : "bg-surface-2 text-muted",
                  )}
                >
                  <span className={cx("size-1.5 rounded-full", agent.status === "active" ? "bg-success" : agent.status === "paused" ? "bg-amber-500" : "bg-muted")} />
                  {t.status[agent.status]}
                </span>
              </div>
              <div className="mt-0.5 truncate text-sm text-muted">
                {model} · v{agent.version}
              </div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
            <span className="tabular-nums">
              <b className="font-semibold text-text">{stats?.week ?? 0}</b> {t.agentHeader.conversations}
              {(stats?.waiting ?? 0) > 0 && (
                <>
                  {" · "}
                  <Link href={`/inbox?agent=${agentId}&f=attention`} className="font-medium text-danger hover:underline">
                    {stats?.waiting} {t.agentHeader.waiting}
                  </Link>
                </>
              )}
              {" · "}
              <b className="font-semibold text-text">${spend.toFixed(2)}</b> {t.agentHeader.spend}
            </span>
            <Link href={`/inbox?agent=${agentId}`} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
              <MessagesSquare className="size-4" />
              {t.agentHeader.openInbox}
            </Link>
          </div>
        </div>
        <AgentTabs agentId={agentId} channels={channelCount} gaps={gaps} proposals={proposals} />
      </header>
      {children}
    </div>
  );
}

/** Начало последних 7 дней и текущего месяца — для сводки в шапке. */
function periods() {
  const now = new Date();
  return { week: new Date(now.getTime() - 7 * 86_400_000), monthStart: new Date(now.getFullYear(), now.getMonth(), 1) };
}
