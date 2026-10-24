import Link from "next/link";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { LogOut } from "lucide-react";
import { db } from "@/db";
import { clients, conversations, knowledgeGaps, messages, payments } from "@/db/schema";
import { requirePortalUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getBrand } from "@/lib/whitelabel";
import { resolutionStats } from "@/lib/agent/resolution";
import { logout } from "@/app/actions/auth";
import { Card, cx } from "@/components/ui";
import { GapAnswer, PortalReply } from "./forms";

const TABS = ["overview", "leads", "chats", "gaps"] as const;

/**
 * Кабинет клиента (владельца бизнеса): итоги месяца, заявки, разговоры с ответом от себя, вопросы без ответа
 * (ответ — в базу знаний агента). Шапка — в бренде студии. Сотрудник студии видит кабинет по ?client=.
 */
export default async function PortalPage({ searchParams }: { searchParams: Promise<{ tab?: string; c?: string; client?: string }> }) {
  const sp = await searchParams;
  const { clientId, staff } = await requirePortalUser(sp.client);
  const { t } = await getT();
  const p = t.portal;
  const brand = await getBrand();
  const tab = TABS.find((x) => x === sp.tab) ?? "overview";
  const q = (patch: Record<string, string>) => `/portal?${new URLSearchParams({ ...(staff ? { client: clientId } : {}), ...patch })}`;
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const own = and(eq(conversations.clientId, clientId), eq(conversations.isTest, false));

  const [[stats], res, paid, gaps, list] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)`,
        hot: sql<number>`sum(case when json_extract(${conversations.context}, '$.lead.temperature') = 'hot' then 1 else 0 end)`,
        attention: sql<number>`sum(case when ${conversations.needsAttention} = 1 and ${conversations.status} != 'closed' then 1 else 0 end)`,
      })
      .from(conversations)
      .where(and(own, gte(conversations.lastMessageAt, month))),
    resolutionStats(month, clientId),
    db.select({ currency: payments.currency, sum: sql<number>`sum(${payments.amount})`, n: sql<number>`count(*)` }).from(payments).where(and(eq(payments.clientId, clientId), eq(payments.status, "paid"), gte(payments.paidAt, month))).groupBy(payments.currency),
    db.select().from(knowledgeGaps).where(and(eq(knowledgeGaps.clientId, clientId), eq(knowledgeGaps.status, "open"))).orderBy(desc(knowledgeGaps.count)).limit(30),
    db
      .select()
      .from(conversations)
      .where(and(own, tab === "leads" ? sql`json_extract(${conversations.context}, '$.lead.temperature') in ('hot','warm')` : undefined))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(60),
  ]);
  const [thread] = sp.c ? await db.select().from(conversations).where(and(eq(conversations.id, sp.c), own)) : [];
  const threadMsgs = thread ? await db.select().from(messages).where(and(eq(messages.conversationId, thread.id), eq(messages.status, "sent"))).orderBy(asc(messages.createdAt)) : [];
  const fmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
  const rate = res.all.rate === null ? "—" : `${Math.round(res.all.rate * 100)}%`;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          {brand.logo.startsWith("https://") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logo} alt="" className="h-8 w-auto rounded" />
          ) : (
            <span className="grid size-8 place-items-center rounded-lg text-lg text-white" style={{ background: brand.color }}>
              {brand.logo || brand.name.charAt(0)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{brand.name}</div>
            <div className="truncate text-xs text-muted">{client?.name}</div>
          </div>
          {staff ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs">{p.preview}</span>
          ) : (
            <form action={logout}>
              <button className="flex items-center gap-1 text-sm text-muted hover:text-text">
                <LogOut className="size-4" />
                {t.nav.logout}
              </button>
            </form>
          )}
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
          {TABS.map((x) => (
            <Link key={x} href={q({ tab: x })} className={cx("border-b-2 px-3 py-2 text-sm whitespace-nowrap", tab === x && !sp.c ? "font-medium" : "border-transparent text-muted hover:text-text")} style={tab === x && !sp.c ? { borderColor: brand.color } : undefined}>
              {p.tabs[x]}
              {x === "gaps" && gaps.length > 0 && <span className="ml-1 text-xs text-muted">{gaps.length}</span>}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {thread ? (
          <Card className="space-y-3 p-5">
            <Link href={q({ tab })} className="text-sm text-muted hover:text-text">
              ← {p.back}
            </Link>
            <div className="font-semibold">{thread.contactName || thread.contactHandle || p.customer}</div>
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {threadMsgs
                .filter((m) => m.role !== "system")
                .map((m) => (
                  <div key={m.id} className={cx("max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap", m.role === "user" ? "bg-surface-2" : "ml-auto text-white")} style={m.role === "user" ? undefined : { background: brand.color }}>
                    {m.text}
                    <div className="mt-1 text-[10px] opacity-70">
                      {m.role === "user" ? p.customer : m.role === "assistant" ? p.agent : p.manager} · {fmt.format(m.createdAt)}
                    </div>
                  </div>
                ))}
            </div>
            <PortalReply conversationId={thread.id} />
          </Card>
        ) : tab === "overview" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                [p.conversations, Number(stats?.total ?? 0)],
                [p.resolved, rate],
                [p.hot, Number(stats?.hot ?? 0)],
                [p.paid, paid.length ? paid.map((x) => `${Math.round(Number(x.sum))} ${x.currency}`).join(" + ") : "—"],
              ].map(([label, value]) => (
                <Card key={String(label)} className="p-4">
                  <div className="text-xs text-muted">{label}</div>
                  <div className="text-2xl font-semibold">{value}</div>
                </Card>
              ))}
            </div>
            <Card className="p-5 text-sm">
              <div className="mb-2 font-semibold">{p.monthTitle}</div>
              <p className="text-muted">
                {p.monthText
                  .replace("{confirmed}", String(res.all.confirmed))
                  .replace("{assumed}", String(res.all.assumed))
                  .replace("{escalated}", String(res.all.escalated))
                  .replace("{attention}", String(stats?.attention ?? 0))}
              </p>
              {gaps.length > 0 && (
                <Link href={q({ tab: "gaps" })} className="mt-2 inline-block font-medium" style={{ color: brand.color }}>
                  {p.gapsCta.replace("{n}", String(gaps.length))} →
                </Link>
              )}
            </Card>
            {brand.support && <p className="text-center text-xs text-muted">{p.support}: {brand.support}</p>}
          </>
        ) : tab === "gaps" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">{p.gapsHint}</p>
            {gaps.length === 0 && <Card className="p-5 text-sm text-muted">{p.gapsEmpty}</Card>}
            {gaps.map((g) => (
              <Card key={g.id} className="space-y-2 p-4">
                <div className="font-medium">{g.question}</div>
                <div className="text-xs text-muted">{p.asked.replace("{n}", String(g.count))}</div>
                <GapAnswer gapId={g.id} suggestion={g.suggestion ?? ""} />
              </Card>
            ))}
          </div>
        ) : (
          <Card className="divide-y divide-border">
            {list.length === 0 && <p className="p-5 text-sm text-muted">{p.empty}</p>}
            {list.map((c) => (
              <Link key={c.id} href={q({ tab, c: c.id })} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.contactName || c.contactHandle || p.customer}</span>
                  {c.context?.lead && <span className="ml-2 text-xs">{c.context.lead.temperature === "hot" ? "🔥" : c.context.lead.temperature === "warm" ? "🌤" : ""}</span>}
                  <span className="block truncate text-muted">{c.lastMessageText}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">{fmt.format(c.lastMessageAt)}</span>
              </Link>
            ))}
          </Card>
        )}
      </main>
    </div>
  );
}
