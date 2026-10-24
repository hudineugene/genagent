import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { BarChart3, Blocks, BookOpen, Bot, Calculator, LayoutDashboard, ClipboardList, ClipboardCheck, FileBarChart2, FileText, Gift, Mail, Mic, PenLine, Route, Truck, Table2, Megaphone, Plus, Settings, Wrench } from "lucide-react";
import { db } from "@/db";
import { agents, approvals, campaigns, clientPricing, routingRules, contactLists, contacts, outreach, outreachMessages, channels, clientLogistics, contentItems, loyaltyAccounts, loyaltyPrograms, loyaltyTx, meetings, clientDocTypes, clientDocuments, clientForms, dataTables, clientIntegrations, clientTools, clients, conversations, docTemplates, formResponses, generatedDocs, kbSources, knowledgeGaps, routines } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { findModel } from "@/lib/models";
import type { Dict, Locale } from "@/lib/i18n";
import { BackLink } from "@/components/back-link";
import { Badge, Card, ClientAvatar, EmptyState, PageHeader, buttonClass, cx } from "@/components/ui";
import { KnowledgeBase } from "./knowledge-base";
import { ToolsManager } from "./tools";
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
import { publicUrl } from "@/lib/settings";
import { campaignStats } from "@/lib/campaigns/engine";
import { getGoogleSettings } from "@/lib/google/calendar";
import { OwnersCard } from "./owners";
import { clientOwners, getNotifySettings } from "@/lib/notify/telegram";
import { embeddingProgress, embeddingStatus } from "@/lib/kb/embeddings";
import { previousMonth } from "@/lib/agent/report";
import { hasTeamAgents } from "@/lib/team/approvals";
import { hasKey } from "@/lib/keys";

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ clientId }, { tab }] = await Promise.all([params, searchParams]);
  const { t, locale } = await getT();
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) notFound();

  const SECTIONS = ["kb", "data", "modules", "outreach", "routing", "pricing", "tools", "forms", "documents", "loyalty", "logistics", "approvals", "campaigns", "content", "meetings", "routines"] as const;
  const active = (SECTIONS as readonly string[]).includes(tab ?? "") ? (tab as (typeof SECTIONS)[number]) : "agents";
  const [[{ agentsCount }], [{ kbCount }], [{ toolsCount }], [{ campaignsCount }], [{ formsCount }], [{ routinesCount }], [{ docTypesCount }], [{ templatesCount }], [{ tablesCount }], [{ pendingApprovals }], [{ approvalsCount }], teamAgents, [{ contentCount }], [{ meetingsCount }], [{ programsCount }], [{ outsCount }], [logistics], agentConfigs, [{ routingCount }], [pricingRow]] = await Promise.all([
    db.select({ agentsCount: count() }).from(agents).where(eq(agents.clientId, clientId)),
    db.select({ kbCount: count() }).from(kbSources).where(eq(kbSources.clientId, clientId)),
    db.select({ toolsCount: count() }).from(clientTools).where(eq(clientTools.clientId, clientId)),
    db.select({ campaignsCount: count() }).from(campaigns).where(eq(campaigns.clientId, clientId)),
    db.select({ formsCount: count() }).from(clientForms).where(eq(clientForms.clientId, clientId)),
    db.select({ routinesCount: count() }).from(routines).where(eq(routines.clientId, clientId)),
    db.select({ docTypesCount: count() }).from(clientDocTypes).where(eq(clientDocTypes.clientId, clientId)),
    db.select({ templatesCount: count() }).from(docTemplates).where(eq(docTemplates.clientId, clientId)),
    db.select({ tablesCount: count() }).from(dataTables).where(eq(dataTables.clientId, clientId)),
    db.select({ pendingApprovals: count() }).from(approvals).where(and(eq(approvals.clientId, clientId), eq(approvals.status, "pending"))),
    db.select({ approvalsCount: count() }).from(approvals).where(eq(approvals.clientId, clientId)),
    hasTeamAgents(clientId),
    db.select({ contentCount: count() }).from(contentItems).where(eq(contentItems.clientId, clientId)),
    db.select({ meetingsCount: count() }).from(meetings).where(eq(meetings.clientId, clientId)),
    db.select({ programsCount: count() }).from(loyaltyPrograms).where(eq(loyaltyPrograms.clientId, clientId)),
    db.select({ outsCount: count() }).from(clientIntegrations).where(eq(clientIntegrations.clientId, clientId)),
    db.select({ base: clientLogistics.baseAddress }).from(clientLogistics).where(eq(clientLogistics.clientId, clientId)),
    db.select({ config: agents.config }).from(agents).where(eq(agents.clientId, clientId)),
    db.select({ routingCount: count() }).from(routingRules).where(eq(routingRules.clientId, clientId)),
    db.select({ tableId: clientPricing.tableId }).from(clientPricing).where(eq(clientPricing.clientId, clientId)),
  ]);

  const base = `/clients/${client.id}`;
  const used = (f: (c: (typeof agentConfigs)[number]["config"]) => boolean) => agentConfigs.filter((a) => f(a.config)).length;
  const modules: ModuleCard[] = [
    { key: "tools", icon: Wrench, title: t.tools.tab, text: t.ws.mod.tools, n: toolsCount + outsCount, used: used((c) => Boolean(c.toolIds?.length)) },
    { key: "forms", icon: ClipboardList, title: t.forms.tab, text: t.ws.mod.forms, n: formsCount, used: used((c) => Boolean(c.formIds?.length)) },
    { key: "documents", icon: FileText, title: t.documents.tab, text: t.ws.mod.documents, n: docTypesCount + templatesCount, used: used((c) => Boolean(c.docTemplateIds?.length)) },
    { key: "loyalty", icon: Gift, title: t.loyalty.tab, text: t.ws.mod.loyalty, n: programsCount, used: used((c) => Boolean(c.loyaltyProgramId)) },
    { key: "logistics", icon: Truck, title: t.logistics.tab, text: t.ws.mod.logistics, n: logistics?.base ? 1 : 0, used: used((c) => Boolean(c.logistics)) },
    { key: "pricing", icon: Calculator, title: t.pricing.tab, text: t.ws.mod.pricing, n: pricingRow?.tableId ? 1 : 0, used: used((c) => Boolean(c.pricing)) },
    { key: "routing", icon: Route, title: t.routing.tab, text: t.ws.mod.routing, n: routingCount, used: 0 },
    { key: "approvals", icon: ClipboardCheck, title: t.ws.mod.teamTitle, text: t.ws.mod.team, n: teamAgents ? 1 : approvalsCount, used: used((c) => Boolean(c.team?.enabled)), badge: pendingApprovals },
  ];
  const nav: { title?: string; items: { key: string; label: string; icon: typeof Bot; n?: number; alert?: number }[] }[] = [
    { items: [{ key: "agents", label: t.ws.overview, icon: LayoutDashboard, n: agentsCount }] },
    {
      title: t.ws.knowledge,
      items: [
        { key: "kb", label: t.kb.tab, icon: BookOpen, n: kbCount },
        { key: "data", label: t.data.tab, icon: Table2, n: tablesCount },
      ],
    },
    {
      title: t.ws.modules,
      items: [
        { key: "modules", label: t.ws.catalog, icon: Blocks, n: modules.filter((m) => m.n > 0).length },
        // В меню — только настроенные модули и открытый сейчас; остальные — в каталоге
        ...modules.filter((m) => m.n > 0 || m.key === active).map((m) => ({ key: m.key, label: m.title, icon: m.icon, alert: m.badge })),
      ],
    },
    {
      title: t.ws.work,
      items: [
        { key: "campaigns", label: t.campaigns.tab, icon: Megaphone, n: campaignsCount },
        { key: "outreach", label: t.outreach.tab, icon: Mail },
        { key: "content", label: t.content.tab, icon: PenLine, n: contentCount },
        { key: "meetings", label: t.meetings.tab, icon: Mic, n: meetingsCount },
        { key: "routines", label: t.routines.tab, icon: FileBarChart2, n: routinesCount },
      ],
    },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <BackLink href="/clients" label={t.nav.clients} />
      <PageHeader
        icon={<ClientAvatar name={client.name} color={client.color} size={40} />}
        title={client.name}
        subtitle={[client.industry, client.website].filter(Boolean).join(" · ") || undefined}
        actions={
          <>
            {/* Отчёт владельцу бизнеса за прошлый месяц — открыть, распечатать в PDF, переслать */}
            <a href={`/api/reports/${client.id}?month=${previousMonth()}`} target="_blank" rel="noopener" className={buttonClass("secondary")} title={t.client.reportHint}>
              <BarChart3 className="size-4" />
              {t.client.report}
            </a>
            <Link href={`/clients/${client.id}/edit`} className={buttonClass("secondary")}>
              <Settings className="size-4" />
              {t.client.settings}
            </Link>
            <Link href={`/clients/${client.id}/agents/new`} className={buttonClass()}>
              <Plus className="size-4" />
              {t.client.newAgent}
            </Link>
          </>
        }
      />

      <div className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)] md:gap-8">
        {/* Разделы клиента: на компьютере — колонка слева, на телефоне — строка с прокруткой */}
        <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] md:sticky md:top-6 md:mx-0 md:flex-col md:gap-4 md:self-start md:overflow-visible md:p-0">
          {nav.map((g, i) => (
            <div key={i} className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
              {g.title && <div className="hidden px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase md:block">{g.title}</div>}
              {g.items.map(({ key, label, icon: Icon, n, alert }) => (
                <Link
                  key={key}
                  href={key === "agents" ? base : `${base}?tab=${key}`}
                  replace
                  className={cx(
                    "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap transition",
                    active === key ? "bg-surface font-medium text-text shadow-[0_0_0_1px_var(--border)] [&>svg]:text-accent" : "text-muted hover:bg-surface hover:text-text",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {alert ? (
                    <span className="min-w-5 rounded-full bg-danger px-1.5 text-center text-[11px] leading-5 font-semibold text-white">{alert}</span>
                  ) : n ? (
                    <span className="text-xs text-muted">{n}</span>
                  ) : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0">
      {active === "kb" ? (
        <KnowledgeTab clientId={client.id} />
      ) : active === "tools" ? (
        <ToolsTab clientId={client.id} />
      ) : active === "campaigns" ? (
        <CampaignsTab clientId={client.id} />
      ) : active === "forms" ? (
        <FormsTab clientId={client.id} />
      ) : active === "pricing" ? (
        <PricingTab clientId={client.id} />
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
        <ModulesCatalog base={base} modules={modules} t={t} />
      ) : (
        <AgentsTab clientId={client.id} t={t} locale={locale} base={base} modules={modules} />
      )}
        </div>
      </div>
    </div>
  );
}

type ModuleCard = { key: string; icon: typeof Bot; title: string; text: string; n: number; used: number; badge?: number };

/** Каталог модулей: что можно подключить клиенту, что уже настроено и сколько агентов этим пользуется. */
function ModulesCatalog({ base, modules, t }: { base: string; modules: ModuleCard[]; t: Dict }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t.ws.catalogTitle}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t.ws.catalogHint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {modules.map((m) => (
          <ModuleTile key={m.key} base={base} m={m} t={t} />
        ))}
      </div>
    </div>
  );
}

function ModuleTile({ base, m, t, compact }: { base: string; m: ModuleCard; t: Dict; compact?: boolean }) {
  const on = m.n > 0;
  return (
    <Link href={`${base}?tab=${m.key}`} replace className="group">
      <Card className={cx("flex h-full flex-col gap-2 transition group-hover:border-accent/50", compact ? "p-3.5" : "p-4", !on && "border-dashed bg-surface/60")}>
        <div className="flex items-center gap-2.5">
          <span className={cx("grid size-8 shrink-0 place-items-center rounded-lg", on ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>
            <m.icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-sm leading-tight font-medium">{m.title}</span>
          {m.badge ? <Badge tone="warning">{m.badge}</Badge> : null}
        </div>
        {!compact && <p className="text-[13px] text-muted">{m.text}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Badge tone={on ? "success" : "neutral"}>{on ? t.ws.on : t.ws.off}</Badge>
          {!compact && <span>{on ? (m.used ? t.ws.usedBy.replace("{n}", String(m.used)) : t.ws.notUsed) : t.ws.setUp}</span>}
        </div>
      </Card>
    </Link>
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
  const [l] = await db.select().from(clientLogistics).where(eq(clientLogistics.clientId, clientId));
  return (
    <LogisticsManager
      clientId={clientId}
      mapsKey={await hasKey(clientId, "googleMaps")}
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
              notifyCustomer: p.notifyCustomer,
              enabled: p.enabled,
              apiKey: p.apiKey,
              usedBy: list.filter((a) => a.config.loyaltyProgramId === p.id).map((a) => a.name),
            }
          : null
      }
      accounts={accounts.map((a) => ({ id: a.id, contact: a.contact, name: a.name, balance: a.balance, updatedAt: a.updatedAt.getTime() }))}
      tx={tx.map(({ t, contact, name }) => ({ contact, name, delta: t.delta, balance: t.balance, reason: t.reason, source: t.source, at: t.createdAt.getTime() }))}
    />
  );
}

async function MeetingsTab({ clientId }: { clientId: string }) {
  const rows = await db.select().from(meetings).where(eq(meetings.clientId, clientId)).orderBy(desc(meetings.createdAt)).limit(100);
  return (
    <MeetingsManager
      clientId={clientId}
      openai={await hasKey(clientId, "openai")}
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
  return <DocumentsManager clientId={clientId} types={typeRows} templates={templateRows} />;
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
  const tools = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
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
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
      <h2 className="text-base font-semibold">{t.ws.modules}</h2>
      <Link href={`${base}?tab=modules`} replace className="text-sm text-accent hover:underline">
        {t.ws.allModules}
      </Link>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
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
