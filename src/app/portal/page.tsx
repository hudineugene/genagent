import Link from "next/link";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { LogOut } from "lucide-react";
import { db } from "@/db";
import { agents, channels, clients, conversations, knowledgeGaps, messages, payments } from "@/db/schema";
import { requirePortalUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { getBrand } from "@/lib/whitelabel";
import { resolutionStats } from "@/lib/agent/resolution";
import { logout } from "@/app/actions/auth";
import { Card, cx } from "@/components/ui";
import { GapAnswer, PortalReply } from "./forms";
import { jsonText } from "@/db/dialect";
import { studioTz } from "@/lib/general";
import { agentConfigSchema } from "@/lib/agent/types";
import { agentMapStats } from "@/lib/agent/map-stats";
import { MODELS } from "@/lib/models";
import { PortalAgentMap } from "./agent-map";
import { AgentReport } from "@/components/agent-map/report";
import { RelTime } from "@/components/rel-time";
import { ThemeSwitch } from "@/components/sidebar";
import { logoDataUri } from "@/lib/client-logo";

/**
 * Цвет бренда студии как акцент кабинета (кнопки, активная вкладка): текст на нём — белый или тёмный, что
 * контрастнее; мягкий фон — смесь с поверхностью. Цвет не в формате #rrggbb — акцент программы.
 */
function brandVars(color: string): Record<string, string> {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return {};
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const onWhite = 1.05 / (lum + 0.05);
  const onDark = (lum + 0.05) / 0.05;
  return { "--accent": color, "--accent-text": onWhite >= onDark ? "#ffffff" : "#111111", "--accent-soft": `color-mix(in srgb, ${color} 14%, var(--surface))` };
}

const TABS = ["overview", "leads", "chats", "gaps", "agent"] as const;

/**
 * Кабинет клиента (владельца бизнеса): итоги месяца, заявки, разговоры с ответом от себя, вопросы без ответа
 * (ответ — в базу знаний агента). Шапка — в бренде студии. Сотрудник студии видит кабинет по ?client=.
 */
export default async function PortalPage({ searchParams }: { searchParams: Promise<{ tab?: string; c?: string; client?: string; report?: string }> }) {
  const sp = await searchParams;
  const { clientId, staff } = await requirePortalUser(sp.client);
  const { t, locale } = await getT();
  const p = t.portal;
  const brand = await getBrand();
  const tab = TABS.find((x) => x === sp.tab) ?? "overview";
  // Отчёт-страница агента для печати в PDF (адрес /portal открыт снаружи — отдельный путь не нужен)
  if (sp.report) {
    const [own] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, sp.report), eq(agents.clientId, clientId)));
    if (own) return <AgentReport agentId={own.id} owner brand={{ name: brand.name, color: brand.color }} locale={(await getT()).locale} />;
  }
  const q = (patch: Record<string, string>) => `/portal?${new URLSearchParams({ ...(staff ? { client: clientId } : {}), ...patch })}`;
  const [client] = await db.select({ name: clients.name, industry: clients.industry, color: clients.color }).from(clients).where(eq(clients.id, clientId));
  const logo = await logoDataUri(clientId);
  const monthName = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { month: "long", year: "numeric", timeZone: studioTz() }).format(new Date());
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const own = and(eq(conversations.clientId, clientId), eq(conversations.isTest, false));

  const [[stats], res, paid, gaps, list] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)`,
        hot: sql<number>`sum(case when ${jsonText(conversations.context, "lead.temperature")} = 'hot' then 1 else 0 end)`,
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
      .where(and(own, tab === "leads" ? sql`${jsonText(conversations.context, "lead.temperature")} in ('hot','warm')` : undefined))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(60),
  ]);
  const [thread] = sp.c ? await db.select().from(conversations).where(and(eq(conversations.id, sp.c), own)) : [];
  const threadMsgs = thread ? await db.select().from(messages).where(and(eq(messages.conversationId, thread.id), eq(messages.status, "sent"))).orderBy(asc(messages.createdAt)) : [];
  const rate = res.all.rate === null ? "—" : `${Math.round(res.all.rate * 100)}%`;

  return (
    <div className="min-h-dvh bg-bg" style={brandVars(brand.color)}>
      <header className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          {brand.logo.startsWith("https://") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logo} alt="" className="h-8 w-auto rounded" />
          ) : (
            <span className="grid size-8 place-items-center rounded-lg text-lg text-white" style={{ background: brand.color }}>
              {brand.logo || brand.name.charAt(0)}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-display font-bold tracking-tight">{brand.name}</span>
          <ThemeSwitch />
          {staff ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs">{p.preview}</span>
          ) : (
            <form action={logout}>
              <button className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted transition hover:bg-surface-2 hover:text-text" aria-label={t.nav.logout}>
                <LogOut className="size-4" />
                <span className="hidden sm:inline">{t.nav.logout}</span>
              </button>
            </form>
          )}
        </div>
      </header>

      {/* Шапка клиента: логотип, название, месяц; полоса — цвет бренда студии */}
      <section className="mx-auto max-w-5xl px-4 pt-6">
        <div className="relative overflow-hidden rounded-2xl border border-border bg-metal">
          <span className="absolute inset-x-0 top-0 h-1" style={{ background: brand.color }} />
          <div className="flex items-center gap-4 px-5 pt-6 pb-4">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- логотип клиента встроен в страницу
              <img src={logo} alt="" width={56} height={56} className="size-14 shrink-0 rounded-xl bg-white object-contain ring-1 ring-border" />
            ) : (
              <span className="grid size-14 shrink-0 place-items-center rounded-xl text-2xl font-semibold text-white" style={{ background: client?.color ?? brand.color }}>
                {(client?.name ?? "?").charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight">{client?.name}</h1>
              <p className="truncate text-sm text-muted first-letter:uppercase">{[client?.industry, monthName].filter(Boolean).join(" · ")}</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 border-t border-border/80 sm:grid-cols-4 [&>div]:px-5 [&>div]:py-3 sm:[&>div+div]:border-l sm:[&>div+div]:border-border/80">
            {[
              [p.conversations, Number(stats?.total ?? 0)],
              [p.resolved, rate],
              [p.hot, Number(stats?.hot ?? 0)],
              [p.paid, paid.length ? paid.map((x) => `${Math.round(Number(x.sum))} ${x.currency}`).join(" + ") : "—"],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex flex-col-reverse">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="font-display text-xl font-bold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <nav className="mt-4 flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {TABS.map((x) => {
            const on = tab === x && !sp.c;
            return (
              <Link
                key={x}
                href={q({ tab: x })}
                aria-current={on ? "page" : undefined}
                className={cx("flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium whitespace-nowrap transition", on ? "bg-accent text-accent-text shadow-sm" : "text-muted hover:bg-surface hover:text-text")}
              >
                {p.tabs[x]}
                {x === "gaps" && gaps.length > 0 && <span className={cx("rounded-full px-1.5 text-xs leading-5", on ? "bg-black/15" : "bg-danger text-on-danger")}>{gaps.length}</span>}
              </Link>
            );
          })}
        </nav>
      </section>
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
                  <div key={m.id} className={cx("max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap", m.role === "user" ? "rounded-bl-md border border-border bg-surface" : "ml-auto rounded-br-md bg-accent-soft")}>
                    {m.text}
                    <div className="mt-1 text-[11px] text-muted">
                      {m.role === "user" ? p.customer : m.role === "assistant" ? p.agent : p.manager} · <RelTime at={m.createdAt} />
                    </div>
                  </div>
                ))}
            </div>
            <PortalReply conversationId={thread.id} />
          </Card>
        ) : tab === "overview" ? (
          <>
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
        ) : tab === "agent" ? (
          <PortalAgents clientId={clientId} clientParam={staff ? clientId : undefined} />
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
                <RelTime at={c.lastMessageAt} className="shrink-0 text-xs text-muted" />
              </Link>
            ))}
          </Card>
        )}
      </main>
    </div>
  );
}

/** «Ваш агент»: карта каждого работающего агента клиента (черновики не показываем), только просмотр. */
async function PortalAgents({ clientId, clientParam }: { clientId: string; clientParam?: string }) {
  const rows = await db.select({ id: agents.id, name: agents.name, status: agents.status, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)).orderBy(asc(agents.createdAt));
  const list = rows.filter((a) => a.status !== "draft");
  const chs = await db.select({ id: channels.id, agentId: channels.agentId, type: channels.type, name: channels.name, enabled: channels.enabled }).from(channels).where(eq(channels.clientId, clientId));
  const maps = await Promise.all(
    list.map(async (a) => {
      const cfg = agentConfigSchema.safeParse(a.config);
      if (!cfg.success) return null;
      const own = chs.filter((c) => c.agentId === a.id).map(({ id, type, name, enabled }) => ({ id, type, name, enabled }));
      return { a, config: cfg.data, channels: own, stats: await agentMapStats(a.id, own.map((c) => c.id)) };
    }),
  );
  return (
    <div className="space-y-8">
      {maps.map(
        (m) =>
          m && (
            <Card key={m.a.id} className="p-4">
              <PortalAgentMap reportHref={`/portal?${new URLSearchParams({ report: m.a.id, ...(clientParam ? { client: clientParam } : {}) })}`} name={m.a.name} config={m.config} channels={m.channels} stats={m.stats} modelLabel={MODELS.find((x) => x.id === m.config.model)?.label ?? m.config.model} />
            </Card>
          ),
      )}
    </div>
  );
}

// Кабинет всегда читает сессию и свежие данные — страница собирается по запросу.
export const instant = false;
