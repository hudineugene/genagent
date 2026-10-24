import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { BarChart3, Bot, Plus, Settings } from "lucide-react";
import { db } from "@/db";
import { agents, approvals, campaigns, candidates, courses, incidents, learners, lessons, monitors, trips, clientRepeat, onboardingPlans, onboardings, reminders, vacancies, clientPricing, clientPayments, payments, procedures, routingRules, contactLists, contacts, outreach, outreachMessages, channels, clientLogistics, contentItems, loyaltyAccounts, loyaltyPrograms, loyaltyTx, meetings, clientDocTypes, clientDocuments, clientForms, dataTables, clientIntegrations, clientTools, clients, conversations, docTemplates, formResponses, generatedDocs, kbSources, knowledgeGaps, routines } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { findModel } from "@/lib/models";
import type { Dict, Locale } from "@/lib/i18n";
import { BackLink } from "@/components/back-link";
import { Badge, Card, ClientAvatar, EmptyState, buttonClass, cx } from "@/components/ui";
import { KnowledgeBase } from "./knowledge-base";
import { ToolsManager } from "./tools";
import { ConnectorsManager } from "./connectors";
import { IntegrationsOut } from "./integrations-out";
import { CampaignsManager } from "./campaigns";
import { FormsManager } from "./forms";
import { RoutinesManager } from "./routines";
import { DocumentsManager } from "./documents";
import { DataManager } from "./data";
import { ApprovalsManager } from "./approvals";
import { ContentStudio } from "./content";
import { MeetingsManager } from "./meetings";
import { LoyaltyManager } from "./loyalty";
import { LogisticsManager } from "./logistics";
import { OutreachManager } from "./outreach";
import { RoutingManager } from "./routing";
import { PricingManager } from "./pricing";
import { PaymentsManager } from "./payments";
import { ProceduresManager } from "./procedures";
import { RemindersManager, RepeatManager } from "./reminders";
import { HiringManager, OnboardingManager } from "./onboarding";
import { MonitorManager } from "./monitor";
import { LearningManager } from "./learning";
import { publicUrl } from "@/lib/settings";
import { campaignStats } from "@/lib/campaigns/engine";
import { getGoogleSettings } from "@/lib/google/calendar";
import { OwnersCard } from "./owners";
import { clientOwners, getNotifySettings } from "@/lib/notify/telegram";
import { embeddingProgress, embeddingStatus } from "@/lib/kb/embeddings";
import { previousMonth } from "@/lib/agent/report";
import { hasTeamAgents } from "@/lib/team/approvals";
import { hasKey } from "@/lib/keys";

import { guardPage } from "@/lib/access";
import { getGeneral, studioTz } from "@/lib/general";
import { ClientMapTab } from "./client-map";
import { logoVersions } from "@/lib/client-logo";
import { dashboardData } from "@/lib/dashboard";
import { CLIENT_TABS, clientSections, type ModuleCard } from "@/lib/client-sections";
import { NAV_ICONS, visibleNav } from "@/lib/nav-icons";
export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ clientId }, { tab }] = await Promise.all([params, searchParams]);
  await guardPage("client", clientId);
  const { t, locale } = await getT();
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) notFound();

  const active = (CLIENT_TABS as readonly string[]).includes(tab ?? "") ? tab! : "agents";
  const { sections, nav: allNav } = await clientSections(clientId, t);
  const base = `/clients/${client.id}`;
  const modules = sections.filter((m) => m.group === "agent");
  const nav = visibleNav(allNav, active);
  const summary = (await dashboardData([client.id])).clients.find((c) => c.id === client.id);

  return (
    <div className="mx-auto max-w-7xl">
      <BackLink href="/clients" label={t.nav.clients} />
      {/* Шапка клиента: логотип, полоса цвета клиента, цифры за 7 дней и главные действия */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-border bg-metal">
        <span className="absolute inset-x-0 top-0 h-1" style={{ background: client.color }} />
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 pt-6 pb-4">
          <div className="flex min-w-0 flex-1 basis-72 items-center gap-4">
            <ClientAvatar id={client.id} v={(await logoVersions()).get(client.id)} name={client.name} color={client.color} size={56} />
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight">{client.name}</h1>
              <p className="mt-0.5 truncate text-sm text-muted">
                {client.industry || "—"}
                {client.website && (
                  <>
                    {" · "}
                    <a href={/^https?:\/\//i.test(client.website) ? client.website : `https://${client.website}`} target="_blank" rel="noopener noreferrer" className="hover:text-accent hover:underline">
                      {client.website.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
                    </a>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Отчёт владельцу бизнеса за прошлый месяц — открыть, распечатать в PDF, переслать */}
            <a href={`/api/reports/${client.id}?month=${previousMonth()}`} target="_blank" rel="noopener" className={buttonClass("secondary")} title={t.client.reportHint}>
              <BarChart3 className="size-4" />
              <span className="max-sm:sr-only">{t.client.report}</span>
            </a>
            <Link href={`/clients/${client.id}/edit`} className={buttonClass("secondary")} title={t.client.settings}>
              <Settings className="size-4" />
              <span className="max-sm:sr-only">{t.client.settings}</span>
            </Link>
            <Link href={`/clients/${client.id}/agents/new`} className={buttonClass()}>
              <Plus className="size-4" />
              {t.client.newAgent}
            </Link>
          </div>
        </div>
        <dl className="grid grid-cols-2 border-t border-border/80 sm:grid-cols-4 [&>div]:px-5 [&>div]:py-3 sm:[&>div+div]:border-l sm:[&>div+div]:border-border/80">
          <HeroStat label={t.client.agents} value={summary?.agents.length ?? 0} />
          <HeroStat label={t.agentHeader.conversations} value={summary?.conversations ?? 0} />
          <HeroStat label={t.agentHeader.waiting} value={summary?.waiting ?? 0} tone={summary?.waiting ? "danger" : undefined} href={summary?.waiting ? `/inbox?client=${client.id}&f=attention` : undefined} />
          <HeroStat label={t.shell.spendWeek} value={`$${(summary?.cost ?? 0).toFixed(2)}`} />
        </dl>
      </section>

      <div className="ctx-grid grid gap-6 md:grid-cols-[200px_minmax(0,1fr)] md:gap-8">
        {/* Разделы клиента: на компьютере — колонка слева, на телефоне — строка с прокруткой */}
        <nav className="ctx-inline -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] md:sticky md:top-6 md:mx-0 md:flex-col md:gap-4 md:self-start md:overflow-visible md:p-0">
          {nav.map((g, i) => (
            <div key={i} className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
              {g.title && <div className="hidden px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase md:block">{g.title}</div>}
              {g.items.map(({ key, label, icon, n, alert }) => {
                const Icon = NAV_ICONS[icon];
                return (
                <Link
                  key={key}
                  href={key === "agents" ? base : `${base}?tab=${key}`}
                  replace
                  className={cx(
                    "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition",
                    active === key ? "bg-surface font-medium text-text shadow-[0_0_0_1px_var(--border)]" : "text-muted hover:bg-surface hover:text-text",
                  )}
                >
                  <span className={cx("grid size-6 shrink-0 place-items-center rounded-md", g.tone)}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="flex-1">{label}</span>
                  {alert ? (
                    <span className="min-w-5 rounded-full bg-danger px-1.5 text-center text-[11px] leading-5 font-semibold text-white">{alert}</span>
                  ) : n ? (
                    <span className="text-xs text-muted">{n}</span>
                  ) : null}
                </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="min-w-0">
      {active === "map" ? (
        <ClientMapTab clientId={client.id} />
      ) : active === "kb" ? (
        <KnowledgeTab clientId={client.id} />
      ) : active === "tools" ? (
        <ToolsTab clientId={client.id} />
      ) : active === "campaigns" ? (
        <CampaignsTab clientId={client.id} />
      ) : active === "procedures" ? (
        <ProceduresTab clientId={client.id} />
      ) : active === "forms" ? (
        <FormsTab clientId={client.id} />
      ) : active === "monitor" ? (
        <MonitorTab clientId={client.id} />
      ) : active === "learning" ? (
        <LearningTab clientId={client.id} />
      ) : active === "reminders" ? (
        <RemindersTab clientId={client.id} />
      ) : active === "repeat" ? (
        <RepeatTab clientId={client.id} />
      ) : active === "onboarding" ? (
        <OnboardingTab clientId={client.id} />
      ) : active === "hiring" ? (
        <HiringTab clientId={client.id} />
      ) : active === "pricing" ? (
        <PricingTab clientId={client.id} />
      ) : active === "payments" ? (
        <PaymentsTab clientId={client.id} />
      ) : active === "routing" ? (
        <RoutingTab clientId={client.id} />
      ) : active === "outreach" ? (
        <OutreachTab clientId={client.id} />
      ) : active === "logistics" ? (
        <LogisticsTab clientId={client.id} />
      ) : active === "loyalty" ? (
        <LoyaltyTab clientId={client.id} />
      ) : active === "meetings" ? (
        <MeetingsTab clientId={client.id} />
      ) : active === "content" ? (
        <ContentTab clientId={client.id} />
      ) : active === "approvals" ? (
        <ApprovalsTab clientId={client.id} />
      ) : active === "data" ? (
        <DataTab clientId={client.id} />
      ) : active === "documents" ? (
        <DocumentsTab clientId={client.id} />
      ) : active === "routines" ? (
        <RoutinesTab clientId={client.id} />
      ) : active === "modules" ? (
        <ModulesCatalog base={base} modules={sections} t={t} />
      ) : (
        <AgentsTab clientId={client.id} t={t} locale={locale} base={base} modules={modules} />
      )}
        </div>
      </div>
    </div>
  );
}

const GROUPS = ["agent", "sales", "ops", "people"] as const;

/** Цифра в шапке клиента: крупное число и подпись; с тревогой — красным и ссылкой. */
function HeroStat({ label, value, tone, href }: { label: string; value: number | string; tone?: "danger"; href?: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cx("font-display text-xl font-bold tabular-nums", tone === "danger" && "text-danger")}>
        {href ? (
          <Link href={href} className="hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/** Все разделы клиента по группам: что настроено, что можно подключить; с чего начать. */
function ModulesCatalog({ base, modules, t }: { base: string; modules: ModuleCard[]; t: Dict }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">{t.ws.catalogTitle}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t.ws.catalogHint}</p>
        <p className="mt-2 max-w-3xl rounded-lg bg-accent-soft px-3 py-2 text-sm">{t.ws.catalogStart}</p>
      </div>
      {GROUPS.map((g) => (
        <section key={g} className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">{t.ws.groups[g]}</h3>
            <p className="text-xs text-muted">{t.ws.groupHints[g]}</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3">
            {modules
              .filter((m) => m.group === g)
              .map((m) => (
                <ModuleTile key={m.key} base={base} m={m} t={t} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ModuleTile({ base, m, t, compact }: { base: string; m: ModuleCard; t: Dict; compact?: boolean }) {
  const on = m.n > 0;
  const Icon = NAV_ICONS[m.icon];
  return (
    <Link href={`${base}?tab=${m.key}`} replace className="group">
      <Card className={cx("flex h-full flex-col gap-2 transition group-hover:border-accent/50", compact ? "p-3.5" : "p-4", !on && "border-dashed bg-surface/60")}>
        <div className="flex items-center gap-2.5">
          <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg", on ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-sm leading-tight font-medium">{m.title}</span>
          {m.badge ? <Badge tone="warning">{m.badge}</Badge> : null}
        </div>
        {!compact && <p className="text-[13px] text-muted">{m.text}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Badge tone={on ? "success" : "neutral"}>{on ? t.ws.on : t.ws.off}</Badge>
          {!compact && <span>{on ? (m.agentless ? "" : m.used ? t.ws.usedBy.replace("{n}", String(m.used)) : t.ws.notUsed) : t.ws.setUp}</span>}
        </div>
      </Card>
    </Link>
  );
}

/** Таблицы клиента (для выбора столбцов) и почтовые каналы (письма тем, у кого нет чата). */
async function tablesAndMail(clientId: string) {
  const [tables, mail] = await Promise.all([
    db.select({ id: dataTables.id, name: dataTables.name, columns: dataTables.columns }).from(dataTables).where(eq(dataTables.clientId, clientId)),
    db.select({ id: channels.id, name: channels.name }).from(channels).where(and(eq(channels.clientId, clientId), eq(channels.type, "email"))),
  ]);
  return { tables: tables.map((x) => ({ id: x.id, name: x.name, columns: x.columns.map((c) => c.name) })), mail };
}

async function MonitorTab({ clientId }: { clientId: string }) {
  const [rows, incs] = await Promise.all([
    db.select().from(monitors).where(eq(monitors.clientId, clientId)).orderBy(asc(monitors.createdAt)),
    db.select({ i: incidents, name: monitors.name }).from(incidents).innerJoin(monitors, eq(monitors.id, incidents.monitorId)).where(eq(incidents.clientId, clientId)).orderBy(desc(incidents.startedAt)).limit(10),
  ]);
  return (
    <MonitorManager
      clientId={clientId}
      apiBase={publicUrl() || ""}
      rows={rows.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        url: m.url,
        expectText: m.expectText,
        maxMs: m.maxMs,
        intervalMin: m.intervalMin,
        failThreshold: m.failThreshold,
        audience: m.audience,
        enabled: m.enabled,
        status: m.status,
        lastCheckAt: m.lastCheckAt?.getTime() ?? null,
        lastMs: m.lastMs,
        lastError: m.lastError,
        apiKey: m.apiKey,
      }))}
      incidents={incs.map(({ i, name }) => ({ id: i.id, monitorId: i.monitorId, monitor: name, error: i.error, draft: i.draft, resolvedDraft: i.resolvedDraft, status: i.status, campaignId: i.campaignId, startedAt: i.startedAt.getTime(), resolvedAt: i.resolvedAt?.getTime() ?? null }))}
    />
  );
}

async function LearningTab({ clientId }: { clientId: string }) {
  const [list, people, programs, agentList] = await Promise.all([
    db.select().from(courses).where(eq(courses.clientId, clientId)).orderBy(asc(courses.position), asc(courses.createdAt)),
    db.select().from(learners).where(eq(learners.clientId, clientId)).orderBy(desc(learners.lastActivityAt)).limit(300),
    db.select({ id: loyaltyPrograms.id, name: loyaltyPrograms.name }).from(loyaltyPrograms).where(eq(loyaltyPrograms.clientId, clientId)),
    db.select({ config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
  ]);
  const ls = list.length ? await db.select().from(lessons).where(inArray(lessons.courseId, list.map((c) => c.id))).orderBy(asc(lessons.position), asc(lessons.createdAt)) : [];
  return (
    <LearningManager
      clientId={clientId}
      programs={programs}
      agentOn={agentList.some((a) => a.config.learning)}
      stats={await import("@/lib/learning").then((m) => m.learningStats(clientId))}
      rows={list.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        level: c.level,
        topics: c.topics,
        points: c.points,
        programId: c.programId,
        enabled: c.enabled,
        position: c.position,
        lessons: ls.filter((x) => x.courseId === c.id).map((x) => ({ id: x.id, position: x.position, title: x.title, body: x.body, videoUrl: x.videoUrl, quiz: x.quiz, passScore: x.passScore, points: x.points })),
      }))}
      learners={people.map((p) => ({ id: p.id, name: p.name, contact: p.contact, goal: p.goal, level: p.level, points: p.points, passed: Object.values(p.results).filter((r) => r.passed).length, lastActivityAt: p.lastActivityAt?.getTime() ?? null }))}
    />
  );
}

async function RemindersTab({ clientId }: { clientId: string }) {
  const [{ tables, mail }, rows] = await Promise.all([tablesAndMail(clientId), db.select().from(reminders).where(eq(reminders.clientId, clientId)).orderBy(desc(reminders.createdAt))]);
  return (
    <RemindersManager
      clientId={clientId}
      tables={tables}
      channels={mail}
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        tableId: r.tableId ?? "",
        kind: r.kind,
        dateColumn: r.dateColumn,
        offsetDays: r.offsetDays,
        keyColumn: r.keyColumn,
        statusColumn: r.statusColumn,
        statusValues: r.statusValues,
        contactColumn: r.contactColumn,
        channelId: r.channelId,
        message: r.message,
        hour: r.hour,
        notifyTeam: r.notifyTeam,
        enabled: r.enabled,
        lastRunAt: r.lastRunAt?.getTime() ?? null,
        lastResult: r.lastResult,
      }))}
    />
  );
}

async function RepeatTab({ clientId }: { clientId: string }) {
  const [{ tables, mail }, [cfg]] = await Promise.all([tablesAndMail(clientId), db.select().from(clientRepeat).where(eq(clientRepeat.clientId, clientId))]);
  const { loadRepeat, predictRepeat } = await import("@/lib/repeat");
  const { kyivNow } = await import("@/lib/reach");
  const found = cfg ? await loadRepeat(clientId) : null;
  let list: ReturnType<typeof predictRepeat> = [];
  try {
    list = found ? predictRepeat(found.cfg, found.table, kyivNow().date) : [];
  } catch {
    list = [];
  }
  return (
    <RepeatManager
      clientId={clientId}
      tables={tables}
      channels={mail}
      list={list}
      config={
        cfg
          ? {
              tableId: cfg.tableId ?? "",
              customerColumn: cfg.customerColumn,
              dateColumn: cfg.dateColumn,
              contactColumn: cfg.contactColumn,
              productColumn: cfg.productColumn,
              amountColumn: cfg.amountColumn,
              leadDays: cfg.leadDays,
              minOrders: cfg.minOrders,
              auto: cfg.auto,
              brief: cfg.brief,
              channelId: cfg.channelId,
              hour: cfg.hour,
              lastRunAt: cfg.lastRunAt?.getTime() ?? null,
              lastResult: cfg.lastResult,
            }
          : null
      }
    />
  );
}

async function OnboardingTab({ clientId }: { clientId: string }) {
  const [plans, rows, { mail }, teamAgents] = await Promise.all([
    db.select().from(onboardingPlans).where(eq(onboardingPlans.clientId, clientId)).orderBy(asc(onboardingPlans.createdAt)),
    db.select().from(onboardings).where(eq(onboardings.clientId, clientId)).orderBy(asc(onboardings.status), desc(onboardings.createdAt)).limit(200),
    tablesAndMail(clientId),
    hasTeamAgents(clientId),
  ]);
  return (
    <OnboardingManager
      clientId={clientId}
      channels={mail}
      teamAgent={teamAgents}
      plans={plans.map((p) => ({ id: p.id, name: p.name, steps: p.steps, welcome: p.welcome }))}
      rows={rows.map((r) => ({ id: r.id, name: r.name, role: r.role, contact: r.contact, email: r.email, startDate: r.startDate, items: r.items, welcomeStatus: r.welcomeStatus, welcomeText: r.welcomeText, status: r.status }))}
    />
  );
}

async function HiringTab({ clientId }: { clientId: string }) {
  const list = await db.select().from(vacancies).where(eq(vacancies.clientId, clientId)).orderBy(desc(vacancies.createdAt));
  const cands = list.length ? await db.select().from(candidates).where(inArray(candidates.vacancyId, list.map((v) => v.id))) : [];
  return (
    <HiringManager
      clientId={clientId}
      rows={list.map((v) => ({
        id: v.id,
        title: v.title,
        requirements: v.requirements,
        candidates: cands
          .filter((c) => c.vacancyId === v.id)
          .map((c) => ({ id: c.id, name: c.name, contact: c.contact, filename: c.filename, score: c.score, verdict: c.verdict, summary: c.summary, strengths: c.strengths, gaps: c.gaps, status: c.status, error: c.error })),
      }))}
    />
  );
}

async function PricingTab({ clientId }: { clientId: string }) {
  const [[p], tables] = await Promise.all([
    db.select().from(clientPricing).where(eq(clientPricing.clientId, clientId)),
    db.select({ id: dataTables.id, name: dataTables.name, columns: dataTables.columns }).from(dataTables).where(eq(dataTables.clientId, clientId)),
  ]);
  return (
    <PricingManager
      clientId={clientId}
      tables={tables.map((x) => ({ id: x.id, name: x.name, columns: x.columns.map((c) => c.name) }))}
      initial={{
        tableId: p?.tableId ?? null,
        nameColumn: p?.nameColumn ?? "",
        priceColumn: p?.priceColumn ?? "",
        tierBy: p?.tierBy ?? "amount",
        tiers: p?.tiers ?? [],
        vat: p?.vat ?? 0,
        currency: p?.currency ?? "€",
        notes: p?.notes ?? "",
      }}
    />
  );
}

async function PaymentsTab({ clientId }: { clientId: string }) {
  const { maskKey } = await import("@/lib/keys");
  const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [[cfg], list] = await Promise.all([
    db.select().from(clientPayments).where(eq(clientPayments.clientId, clientId)),
    db
      .select({ p: payments, contact: conversations.contactName })
      .from(payments)
      .leftJoin(conversations, eq(conversations.id, payments.conversationId))
      .where(eq(payments.clientId, clientId))
      .orderBy(desc(payments.createdAt))
      .limit(50),
  ]);
  const month = list.filter((x) => x.p.createdAt >= since);
  const paid = month.filter((x) => x.p.status === "paid");
  const sums = new Map<string, number>();
  for (const x of paid) sums.set(x.p.currency, (sums.get(x.p.currency) ?? 0) + x.p.amount);
  const c = cfg?.credentials ?? {};
  return (
    <PaymentsManager
      clientId={clientId}
      currency={(await getGeneral()).currency}
      initial={
        cfg
          ? {
              provider: cfg.provider,
              publicKey: c.publicKey ?? "",
              merchant: c.merchant ?? "",
              domain: c.domain ?? "",
              privateKeyMask: c.privateKey ? maskKey(c.privateKey) : "",
              secretMask: c.secret ? maskKey(c.secret) : "",
              tokenMask: c.token ? maskKey(c.token) : "",
              currency: cfg.currency as "UAH" | "USD" | "EUR",
              maxAmount: cfg.maxAmount,
              paidText: cfg.paidText,
              enabled: cfg.enabled,
            }
          : null
      }
      month={{ paid: paid.length, links: month.length, sum: [...sums].map(([cur, n]) => `${Math.round(n * 100) / 100} ${cur}`).join(" + ") }}
      list={list.map((x) => ({
        id: x.p.id,
        at: x.p.createdAt.toLocaleString("ru-RU", { timeZone: studioTz(), day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
        amount: x.p.amount,
        currency: x.p.currency,
        description: x.p.description,
        status: x.p.status,
        contact: x.contact ?? "",
        conversationId: x.p.conversationId,
      }))}
    />
  );
}

async function RoutingTab({ clientId }: { clientId: string }) {
  const [rules, notify] = await Promise.all([
    db.select().from(routingRules).where(eq(routingRules.clientId, clientId)).orderBy(asc(routingRules.position), asc(routingRules.createdAt)),
    getNotifySettings(),
  ]);
  const people = [
    ...(notify?.subscribers ?? []).map((p) => ({ chatId: p.chatId, name: p.name, kind: "studio" as const })),
    ...(notify?.owners ?? []).filter((o) => o.clientId === clientId).map((p) => ({ chatId: p.chatId, name: p.name, kind: "owner" as const })),
  ];
  return <RoutingManager clientId={clientId} rules={rules.map((r) => ({ id: r.id, name: r.name, description: r.description, chatIds: r.chatIds }))} people={people} />;
}

async function OutreachTab({ clientId }: { clientId: string }) {
  const [lists, items, emailChannels, services] = await Promise.all([
    db.select().from(contactLists).where(eq(contactLists.clientId, clientId)).orderBy(desc(contactLists.createdAt)),
    db.select().from(outreach).where(eq(outreach.clientId, clientId)).orderBy(desc(outreach.createdAt)),
    db.select({ id: channels.id, name: channels.name }).from(channels).where(and(eq(channels.clientId, clientId), eq(channels.type, "email"))),
    import("@/lib/services").then((m) => m.getServices()),
  ]);
  const listRows = await Promise.all(
    lists.map(async (l) => {
      const cs = await db.select({ email: contacts.email, grp: contacts.grp, unsubscribed: contacts.unsubscribed }).from(contacts).where(eq(contacts.listId, l.id));
      const groups = new Map<string, number>();
      for (const c of cs) if (c.grp) groups.set(c.grp, (groups.get(c.grp) ?? 0) + 1);
      return { id: l.id, name: l.name, count: cs.length, withEmail: cs.filter((c) => c.email).length, unsubscribed: cs.filter((c) => c.unsubscribed).length, groups: [...groups].map(([name, n]) => ({ name, n })).slice(0, 20) };
    }),
  );
  const counts = items.length
    ? await db
        .select({ id: outreachMessages.outreachId, status: outreachMessages.status, n: count() })
        .from(outreachMessages)
        .where(inArray(outreachMessages.outreachId, items.map((i) => i.id)))
        .groupBy(outreachMessages.outreachId, outreachMessages.status)
    : [];
  return (
    <OutreachManager
      clientId={clientId}
      lists={listRows}
      emailChannels={emailChannels}
      webSearch={services.webSearch.enabled}
      items={items.map((i) => ({
        id: i.id,
        name: i.name,
        listId: i.listId,
        mode: i.mode,
        channelId: i.channelId,
        brief: i.brief,
        groupBriefs: i.groupBriefs,
        research: i.research,
        status: i.status,
        error: i.error,
        counts: Object.fromEntries(counts.filter((c) => c.id === i.id).map((c) => [c.status, c.n])),
      }))}
    />
  );
}

async function LogisticsTab({ clientId }: { clientId: string }) {
  const [[l], tripRows] = await Promise.all([
    db.select().from(clientLogistics).where(eq(clientLogistics.clientId, clientId)),
    db.select().from(trips).where(eq(trips.clientId, clientId)).orderBy(desc(trips.departure)).limit(30),
  ]);
  const { tripStats } = await import("@/lib/logistics/trips");
  return (
    <LogisticsManager
      clientId={clientId}
      mapsKey={await hasKey(clientId, "googleMaps")}
      stats={await tripStats(clientId)}
      trips={tripRows.map((r) => ({
        id: r.id,
        name: r.name,
        vehicle: r.vehicle,
        driver: r.driver,
        driverName: r.driverName,
        departure: r.departure.getTime(),
        stops: r.stops,
        km: r.km,
        minutes: r.minutes,
        mapsUrl: r.mapsUrl,
        status: r.status,
        risk: r.risk,
        notifyCustomers: r.notifyCustomers,
      }))}
      settings={{ baseAddress: l?.baseAddress ?? "", stopMinutes: l?.stopMinutes ?? 10, vehicles: l?.vehicles ?? [], deliveryNote: l?.deliveryNote ?? "" }}
    />
  );
}

async function LoyaltyTab({ clientId }: { clientId: string }) {
  const [[p], list] = await Promise.all([
    db.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.clientId, clientId)).orderBy(asc(loyaltyPrograms.createdAt)).limit(1),
    db.select({ name: agents.name, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
  ]);
  const [accounts, tx] = p
    ? await Promise.all([
        db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.programId, p.id)).orderBy(desc(loyaltyAccounts.updatedAt)).limit(500),
        db
          .select({ t: loyaltyTx, contact: loyaltyAccounts.contact, name: loyaltyAccounts.name })
          .from(loyaltyTx)
          .innerJoin(loyaltyAccounts, eq(loyaltyAccounts.id, loyaltyTx.accountId))
          .where(eq(loyaltyAccounts.programId, p.id))
          .orderBy(desc(loyaltyTx.createdAt))
          .limit(30),
      ])
    : [[], []];
  return (
    <LoyaltyManager
      clientId={clientId}
      apiBase={publicUrl() || ""}
      program={
        p
          ? {
              id: p.id,
              name: p.name,
              unit: p.unit,
              rules: p.rules,
              rewards: p.rewards,
              welcome: p.welcome,
              peerAllowance: p.peerAllowance,
              notifyCustomer: p.notifyCustomer,
              enabled: p.enabled,
              apiKey: p.apiKey,
              usedBy: list.filter((a) => a.config.loyaltyProgramId === p.id).map((a) => a.name),
            }
          : null
      }
      accounts={accounts.map((a) => ({ id: a.id, contact: a.contact, name: a.name, balance: a.balance, updatedAt: a.updatedAt.getTime() }))}
      tx={tx.map(({ t, contact, name }) => ({ contact, name, delta: t.delta, balance: t.balance, reason: t.reason, source: t.source, at: t.createdAt.getTime() }))}
      peer={p && p.peerAllowance > 0 ? await import("@/lib/loyalty/engine").then((m) => m.peerStats(p.id)) : undefined}
    />
  );
}

async function MeetingsTab({ clientId }: { clientId: string }) {
  const rows = await db.select().from(meetings).where(eq(meetings.clientId, clientId)).orderBy(desc(meetings.createdAt)).limit(100);
  return (
    <MeetingsManager
      clientId={clientId}
      openai={await hasKey(clientId, "openai")}
      mailChannels={(await tablesAndMail(clientId)).mail}
      rows={rows.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        instructions: r.instructions,
        filename: r.filename,
        transcript: r.transcript,
        summary: r.summary,
        result: r.result,
        tasks: r.tasks,
        score: r.score,
        status: r.status,
        error: r.error,
        at: r.createdAt.getTime(),
        emails: r.delivery.emails ?? [],
        mailStatus: r.delivery.mailStatus ?? "",
      }))}
    />
  );
}

async function ContentTab({ clientId }: { clientId: string }) {
  const [rows, bots] = await Promise.all([
    db.select().from(contentItems).where(eq(contentItems.clientId, clientId)).orderBy(desc(contentItems.createdAt)).limit(150),
    db.select({ id: channels.id, name: channels.name, type: channels.type }).from(channels).where(and(eq(channels.clientId, clientId), inArray(channels.type, ["telegram", "threads"]))),
  ]);
  return (
    <ContentStudio
      clientId={clientId}
      openai={await hasKey(clientId, "openai")}
      bots={bots.map((b) => ({ id: b.id, name: b.type === "threads" ? `Threads · ${b.name}` : b.name, type: b.type === "threads" ? ("threads" as const) : ("telegram" as const) }))}
      rows={rows.map((r) => ({
        id: r.id,
        batch: r.batch,
        kind: r.kind,
        platform: r.platform,
        brief: r.brief,
        title: r.title,
        text: r.text,
        image: r.image,
        imagePrompt: r.imagePrompt,
        status: r.status,
        channelId: r.channelId,
        target: r.target,
        publishAt: r.publishAt?.getTime() ?? null,
        publishedAt: r.publishedAt?.getTime() ?? null,
        url: r.url,
        error: r.error,
        at: r.createdAt.getTime(),
      }))}
    />
  );
}

async function ApprovalsTab({ clientId }: { clientId: string }) {
  const rows = await db
    .select({ a: approvals, agent: agents.name })
    .from(approvals)
    .leftJoin(agents, eq(agents.id, approvals.agentId))
    .where(eq(approvals.clientId, clientId))
    .orderBy(desc(approvals.createdAt))
    .limit(200);
  // Ждущие решения — сверху
  rows.sort((x, y) => Number(y.a.status === "pending") - Number(x.a.status === "pending"));
  return (
    <ApprovalsManager
      rows={rows.map(({ a, agent }) => ({
        id: a.id,
        number: a.number,
        requester: a.requester,
        agent: agent ?? "",
        subject: a.subject,
        details: a.details,
        amount: a.amount,
        status: a.status,
        decidedBy: a.decidedBy,
        comment: a.comment,
        at: a.createdAt.getTime(),
        decidedAt: a.decidedAt?.getTime() ?? null,
      }))}
    />
  );
}

async function DataTab({ clientId }: { clientId: string }) {
  const [rows, list] = await Promise.all([
    db.select().from(dataTables).where(eq(dataTables.clientId, clientId)).orderBy(desc(dataTables.createdAt)),
    db.select({ name: agents.name, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
  ]);
  return (
    <DataManager
      clientId={clientId}
      tables={rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        sheetUrl: r.sheetUrl,
        sheetName: r.sheetName,
        filename: r.filename,
        columns: r.columns,
        sample: r.rows.slice(0, 5).map((x) => x.map((v) => v.slice(0, 80))),
        rowCount: r.rowCount,
        enabled: r.enabled,
        refreshedAt: r.refreshedAt?.getTime() ?? null,
        error: r.error,
        usedBy: list.filter((a) => a.config.tableIds?.includes(r.id)).map((a) => a.name),
      }))}
    />
  );
}

async function DocumentsTab({ clientId }: { clientId: string }) {
  const [types, templates, list] = await Promise.all([
    db.select().from(clientDocTypes).where(eq(clientDocTypes.clientId, clientId)).orderBy(desc(clientDocTypes.createdAt)),
    db.select().from(docTemplates).where(eq(docTemplates.clientId, clientId)).orderBy(desc(docTemplates.createdAt)),
    db.select({ name: agents.name, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
  ]);
  const typeRows = await Promise.all(
    types.map(async (r) => {
      const [[{ total }], recent] = await Promise.all([
        db.select({ total: count() }).from(clientDocuments).where(eq(clientDocuments.docTypeId, r.id)),
        db
          .select({ d: clientDocuments, contact: conversations.contactName })
          .from(clientDocuments)
          .leftJoin(conversations, eq(conversations.id, clientDocuments.conversationId))
          .where(eq(clientDocuments.docTypeId, r.id))
          .orderBy(desc(clientDocuments.createdAt))
          .limit(10),
      ]);
      return {
        id: r.id,
        name: r.name,
        purpose: r.purpose,
        fields: r.fields,
        notify: r.notify,
        enabled: r.enabled,
        folder: r.folder,
        nameTemplate: r.nameTemplate,
        total,
        recent: recent.map((x) => ({ at: x.d.createdAt.getTime(), contact: x.contact ?? "", filename: x.d.filename, fields: x.d.fields, summary: x.d.summary })),
      };
    }),
  );
  const templateRows = await Promise.all(
    templates.map(async (r) => {
      const recent = await db
        .select({ id: generatedDocs.id, at: generatedDocs.createdAt, title: generatedDocs.title, contact: conversations.contactName })
        .from(generatedDocs)
        .leftJoin(conversations, eq(conversations.id, generatedDocs.conversationId))
        .where(eq(generatedDocs.templateId, r.id))
        .orderBy(desc(generatedDocs.createdAt))
        .limit(10);
      return {
        id: r.id,
        name: r.name,
        purpose: r.purpose,
        body: r.body,
        fields: r.fields,
        enabled: r.enabled,
        counter: r.counter,
        usedBy: list.filter((a) => a.config.docTemplateIds?.includes(r.id)).map((a) => a.name),
        recent: recent.map((x) => ({ id: x.id, at: x.at.getTime(), title: x.title, contact: x.contact ?? "" })),
      };
    }),
  );
  const archive = await db
    .select({ d: clientDocuments, contact: conversations.contactName })
    .from(clientDocuments)
    .leftJoin(conversations, eq(conversations.id, clientDocuments.conversationId))
    .where(eq(clientDocuments.clientId, clientId))
    .orderBy(desc(clientDocuments.createdAt))
    .limit(1000);
  return (
    <DocumentsManager
      clientId={clientId}
      types={typeRows}
      templates={templateRows}
      archive={archive
        .filter((x) => x.d.title || x.d.file)
        .map((x) => ({ id: x.d.id, title: x.d.title || x.d.filename, folder: x.d.folder, summary: x.d.summary, at: x.d.createdAt.getTime(), file: Boolean(x.d.file), size: x.d.size, contact: x.contact ?? "" }))}
    />
  );
}

async function RoutinesTab({ clientId }: { clientId: string }) {
  const [rows, tables] = await Promise.all([
    db.select().from(routines).where(eq(routines.clientId, clientId)).orderBy(desc(routines.createdAt)),
    db.select({ id: dataTables.id, name: dataTables.name }).from(dataTables).where(eq(dataTables.clientId, clientId)),
  ]);
  return (
    <RoutinesManager
      clientId={clientId}
      tables={tables}
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        task: r.task,
        schedule: r.schedule,
        sources: r.sources,
        delivery: r.delivery,
        enabled: r.enabled,
        lastRunAt: r.lastRunAt?.getTime() ?? null,
        lastStatus: r.lastStatus,
        lastResult: r.lastResult,
      }))}
    />
  );
}

async function ProceduresTab({ clientId }: { clientId: string }) {
  const [rows, list, tools] = await Promise.all([
    db.select().from(procedures).where(eq(procedures.clientId, clientId)).orderBy(desc(procedures.createdAt)),
    db.select({ name: agents.name, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
    db.select({ id: clientTools.id, title: clientTools.title, kind: clientTools.kind, params: clientTools.params }).from(clientTools).where(eq(clientTools.clientId, clientId)),
  ]);
  return (
    <ProceduresManager
      clientId={clientId}
      rows={rows.map((r) => ({ id: r.id, name: r.name, trigger: r.trigger, steps: r.steps, enabled: r.enabled, usedBy: list.filter((a) => a.config.procedureIds?.includes(r.id)).map((a) => a.name) }))}
      tools={tools
        .filter((x) => x.kind !== "mcp")
        .map((x) => ({ id: x.id, title: x.title, kind: x.kind, params: x.kind === "crm" ? ["order", "phone", "email"] : x.kind === "sheet" ? ["query"] : x.params.map((p) => p.name) }))}
    />
  );
}

async function FormsTab({ clientId }: { clientId: string }) {
  const [rows, list] = await Promise.all([
    db.select().from(clientForms).where(eq(clientForms.clientId, clientId)).orderBy(desc(clientForms.createdAt)),
    db.select({ name: agents.name, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
  ]);
  const items = await Promise.all(
    rows.map(async (r) => {
      const [[{ total }], recent] = await Promise.all([
        db.select({ total: count() }).from(formResponses).where(eq(formResponses.formId, r.id)),
        db
          .select({ r: formResponses, contact: conversations.contactName })
          .from(formResponses)
          .leftJoin(conversations, eq(conversations.id, formResponses.conversationId))
          .where(eq(formResponses.formId, r.id))
          .orderBy(desc(formResponses.createdAt))
          .limit(10),
      ]);
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        purpose: r.purpose,
        fields: r.fields,
        thanks: r.thanks,
        notify: r.notify,
        enabled: r.enabled,
        total,
        recent: recent.map((x) => ({ at: x.r.createdAt.getTime(), contact: x.contact ?? "", answers: x.r.answers, score: x.r.score, maxScore: x.r.maxScore })),
        usedBy: list.filter((a) => a.config.formIds?.includes(r.id)).map((a) => a.name),
      };
    }),
  );
  return <FormsManager clientId={clientId} rows={items} />;
}

async function CampaignsTab({ clientId }: { clientId: string }) {
  const [rows, list] = await Promise.all([
    db.select().from(campaigns).where(eq(campaigns.clientId, clientId)).orderBy(desc(campaigns.createdAt)),
    db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.clientId, clientId)),
  ]);
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      status: r.status,
      enabled: r.enabled,
      segment: r.segment,
      steps: r.steps,
      trigger: r.trigger,
      scheduleAt: r.scheduleAt?.getTime() ?? null,
      options: r.options,
      stats: await campaignStats(r.id),
    })),
  );
  return <CampaignsManager clientId={clientId} rows={items} agents={list} />;
}

async function ToolsTab({ clientId }: { clientId: string }) {
  const [rows, list, outs, google] = await Promise.all([
    db.select().from(clientTools).where(eq(clientTools.clientId, clientId)).orderBy(desc(clientTools.createdAt)),
    db.select({ name: agents.name, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
    db.select().from(clientIntegrations).where(eq(clientIntegrations.clientId, clientId)).orderBy(desc(clientIntegrations.createdAt)),
    getGoogleSettings(),
  ]);
  const { maskKey } = await import("@/lib/keys");
  const m = (v: unknown) => (typeof v === "string" && v ? maskKey(v) : "");
  const connectors = rows
    .filter((r) => r.kind === "crm" || r.kind === "mcp")
    .map((r) => ({
      id: r.id,
      kind: r.kind as "crm" | "mcp",
      title: r.title,
      name: r.name,
      enabled: r.enabled,
      provider: String(r.config.provider ?? ""),
      domain: String(r.config.domain ?? ""),
      url: r.url,
      keyMask: m(r.config.key),
      secretMask: m(r.config.secret),
      webhookMask: m(r.config.webhook),
      tokenMask: m(r.headers.authorization?.replace(/^Bearer /, "")),
      pushLeads: Boolean(r.config.pushLeads),
      lastStatus: r.lastStatus,
      usedBy: list.filter((a) => a.config.toolIds?.includes(r.id)).map((a) => a.name),
    }));
  const tools = rows.filter((r) => r.kind === "http" || r.kind === "sheet").map((r) => ({
    id: r.id,
    kind: r.kind as "http" | "sheet",
    sheet: r.sheet,
    title: r.title,
    name: r.name,
    description: r.description,
    method: r.method,
    url: r.url,
    headers: r.headers,
    params: r.params,
    readOnly: r.readOnly,
    enabled: r.enabled,
    lastStatus: r.lastStatus,
    lastUsedAt: r.lastUsedAt,
    usedBy: list.filter((a) => a.config.toolIds?.includes(r.id)).map((a) => a.name),
  }));
  const googleEmail = google?.clientEmail ?? null;
  const integrations = outs.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    url: r.config.url,
    sheet: "sheet" in r.config ? r.config.sheet : "",
    secret: "secret" in r.config ? r.config.secret : "",
    events: r.events,
    enabled: r.enabled,
    lastStatus: r.lastStatus,
    lastAt: r.lastAt,
  }));
  return (
    <ToolsManager clientId={clientId} tools={tools} googleEmail={googleEmail}>
      <ConnectorsManager clientId={clientId} rows={connectors} />
      <IntegrationsOut clientId={clientId} rows={integrations} googleEmail={googleEmail} />
    </ToolsManager>
  );
}

async function KnowledgeTab({ clientId }: { clientId: string }) {
  const sources = await db
    .select({
      id: kbSources.id,
      type: kbSources.type,
      title: kbSources.title,
      url: kbSources.url,
      crawl: kbSources.crawl,
      filename: kbSources.filename,
      status: kbSources.status,
      error: kbSources.error,
      chars: kbSources.chars,
      chunks: kbSources.chunks,
      pages: kbSources.pages,
      updatedAt: kbSources.updatedAt,
      externalKey: kbSources.externalKey,
    })
    .from(kbSources)
    .where(eq(kbSources.clientId, clientId))
    .orderBy(desc(kbSources.createdAt));
  const semantic = { ...embeddingStatus(), ...embeddingProgress(clientId) };
  return <KnowledgeBase clientId={clientId} sources={sources} semantic={semantic} />;
}

async function AgentsTab({ clientId, t, locale, base, modules }: { clientId: string; t: Dict; locale: Locale; base: string; modules: ModuleCard[] }) {
  const [list, notify, owners, [{ openGaps }]] = await Promise.all([
    db.select().from(agents).where(eq(agents.clientId, clientId)).orderBy(desc(agents.updatedAt)),
    getNotifySettings(),
    clientOwners(clientId),
    db.select({ openGaps: count() }).from(knowledgeGaps).where(and(eq(knowledgeGaps.clientId, clientId), eq(knowledgeGaps.status, "open"))),
  ]);
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { dateStyle: "medium" });

  if (list.length === 0) {
    return (
      <EmptyState
        icon={<Bot />}
        text={t.client.noAgents}
        action={
          <Link href={`/clients/${clientId}/agents/new`} className={buttonClass()}>
            <Plus className="size-4" />
            {t.client.newAgent}
          </Link>
        }
      />
    );
  }

  return (
    <>
    <h2 className="mb-3 text-base font-semibold">{t.client.agents}</h2>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3">
      {list.map((a) => (
        <Link key={a.id} href={`/agents/${a.id}`} className="group">
          <Card className="flex h-full flex-col gap-3 p-4 transition group-hover:border-accent/50">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-lg">
                {a.config.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{a.name}</div>
                <div className="truncate text-sm text-muted">{a.config.role || "—"}</div>
              </div>
              <Badge tone={a.status === "active" ? "success" : a.status === "paused" ? "warning" : "neutral"}>
                {t.status[a.status]}
              </Badge>
            </div>
            {a.config.description && <p className="line-clamp-2 text-sm text-muted">{a.config.description}</p>}
            <div className="mt-auto flex items-center justify-between pt-1 text-xs text-muted">
              <span>{findModel(a.config.model)?.label ?? a.config.model}</span>
              <span>
                {t.client.updated} {fmt.format(a.updatedAt)}
              </span>
            </div>
          </Card>
        </Link>
      ))}
    </div>
    <div className="mt-8 mb-3 flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold">{t.ws.groups.agent}</h2>
      <Link href={`${base}?tab=modules`} replace className="text-sm text-accent hover:underline">
        {t.ws.catalog}
      </Link>
    </div>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-3">
      {modules.map((m) => (
        <ModuleTile key={m.key} base={base} m={m} t={t} compact />
      ))}
    </div>
    <OwnersCard
      clientId={clientId}
      botReady={Boolean(notify?.token && notify.botUsername)}
      owners={owners.map((o) => ({ chatId: o.chatId, name: o.name, since: o.since }))}
      openGaps={openGaps}
    />
    </>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
