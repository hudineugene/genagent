import Link from "next/link";
import { notFound } from "next/navigation";
import { and, count, desc, eq } from "drizzle-orm";
import { BarChart3, BookOpen, Bot, Megaphone, Plus, Settings, Wrench } from "lucide-react";
import { db } from "@/db";
import { agents, campaigns, clientIntegrations, clientTools, clients, kbSources, knowledgeGaps } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { findModel } from "@/lib/models";
import type { Dict, Locale } from "@/lib/i18n";
import { BackLink } from "@/components/back-link";
import { Badge, Card, ClientAvatar, EmptyState, PageHeader, buttonClass, cx } from "@/components/ui";
import { KnowledgeBase } from "./knowledge-base";
import { ToolsManager } from "./tools";
import { IntegrationsOut } from "./integrations-out";
import { CampaignsManager } from "./campaigns";
import { campaignStats } from "@/lib/campaigns/engine";
import { getGoogleSettings } from "@/lib/google/calendar";
import { OwnersCard } from "./owners";
import { clientOwners, getNotifySettings } from "@/lib/notify/telegram";
import { embeddingProgress, embeddingStatus } from "@/lib/kb/embeddings";
import { previousMonth } from "@/lib/agent/report";

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

  const active = tab === "kb" ? "kb" : tab === "tools" ? "tools" : tab === "campaigns" ? "campaigns" : "agents";
  const [[{ agentsCount }], [{ kbCount }], [{ toolsCount }], [{ campaignsCount }]] = await Promise.all([
    db.select({ agentsCount: count() }).from(agents).where(eq(agents.clientId, clientId)),
    db.select({ kbCount: count() }).from(kbSources).where(eq(kbSources.clientId, clientId)),
    db.select({ toolsCount: count() }).from(clientTools).where(eq(clientTools.clientId, clientId)),
    db.select({ campaignsCount: count() }).from(campaigns).where(eq(campaigns.clientId, clientId)),
  ]);

  const tabs = [
    { key: "agents", href: `/clients/${client.id}`, label: t.client.agents, icon: Bot, n: agentsCount },
    { key: "kb", href: `/clients/${client.id}?tab=kb`, label: t.kb.tab, icon: BookOpen, n: kbCount },
    { key: "tools", href: `/clients/${client.id}?tab=tools`, label: t.tools.tab, icon: Wrench, n: toolsCount },
    { key: "campaigns", href: `/clients/${client.id}?tab=campaigns`, label: t.campaigns.tab, icon: Megaphone, n: campaignsCount },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <BackLink href="/clients" label={t.nav.clients} />
      <PageHeader
        icon={<ClientAvatar name={client.name} color={client.color} size={56} />}
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

      <div className="mb-6 flex gap-1 border-b border-border">
        {tabs.map(({ key, href, label, icon: Icon, n }) => (
          <Link
            key={key}
            href={href}
            replace
            className={cx(
              "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
              active === key ? "border-accent text-accent" : "border-transparent text-muted hover:text-text",
            )}
          >
            <Icon className="size-4" />
            {label}
            <span className="rounded-full bg-surface-2 px-1.5 text-xs text-muted">{n}</span>
          </Link>
        ))}
      </div>

      {active === "kb" ? (
        <KnowledgeTab clientId={client.id} />
      ) : active === "tools" ? (
        <ToolsTab clientId={client.id} />
      ) : active === "campaigns" ? (
        <CampaignsTab clientId={client.id} />
      ) : (
        <AgentsTab clientId={client.id} t={t} locale={locale} />
      )}
    </div>
  );
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

async function AgentsTab({ clientId, t, locale }: { clientId: string; t: Dict; locale: Locale }) {
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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((a) => (
        <Link key={a.id} href={`/agents/${a.id}`} className="group">
          <Card className="flex h-full flex-col gap-3 p-5 transition group-hover:border-accent/50 group-hover:shadow-lg group-hover:shadow-black/5">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-xl">
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
