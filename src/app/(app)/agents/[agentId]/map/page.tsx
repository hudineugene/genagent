import { notFound } from "next/navigation";
import { connection } from "next/server";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  agentVersions,
  channels,
  clientForms,
  clientLogistics,
  clientPayments,
  clientPricing,
  clientTools,
  clients,
  courses,
  dataTables,
  docTemplates,
  kbSources,
  loyaltyPrograms,
  procedures,
} from "@/db/schema";
import { guardPage } from "@/lib/access";
import { agentConfigSchema } from "@/lib/agent/types";
import { getGoogleSettings } from "@/lib/google/calendar";
import { getServices } from "@/lib/services";
import { withKeys } from "@/lib/keys";
import { speechAvailable } from "@/lib/speech";
import { MODELS } from "@/lib/models";
import { agentMapStats, moduleHistory, testCoverage } from "@/lib/agent/map-stats";
import { studioTz } from "@/lib/general";
import { AgentMap } from "./map";

/** Карта агента: каналы → ядро → модули; включение модулей прямо на схеме, сохранение — новой версией. */
export default async function AgentMapPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  await guardPage("agent", agentId);
  await connection();
  const [row] = await db.select({ agent: agents, client: clients }).from(agents).innerJoin(clients, eq(clients.id, agents.clientId)).where(eq(agents.id, agentId));
  if (!row) notFound();
  const { agent, client } = row;
  const cid = client.id;
  const list = <T extends { id: string; name: string }>(rows: T[]) => rows.map((r) => ({ id: r.id, name: r.name }));
  const [chs, kb, tools, forms, procs, docs, tables, programs, [pricing], [logistics], [pay], [{ coursesCount }], google, services] = await Promise.all([
    db.select({ id: channels.id, type: channels.type, name: channels.name, enabled: channels.enabled }).from(channels).where(eq(channels.agentId, agentId)).orderBy(asc(channels.createdAt)),
    db.select({ id: kbSources.id, name: kbSources.title }).from(kbSources).where(eq(kbSources.clientId, cid)).orderBy(asc(kbSources.createdAt)),
    db.select({ id: clientTools.id, name: clientTools.title }).from(clientTools).where(and(eq(clientTools.clientId, cid), eq(clientTools.enabled, true))).orderBy(asc(clientTools.createdAt)),
    db.select({ id: clientForms.id, name: clientForms.name }).from(clientForms).where(and(eq(clientForms.clientId, cid), eq(clientForms.enabled, true))).orderBy(asc(clientForms.createdAt)),
    db.select({ id: procedures.id, name: procedures.name }).from(procedures).where(and(eq(procedures.clientId, cid), eq(procedures.enabled, true))).orderBy(asc(procedures.createdAt)),
    db.select({ id: docTemplates.id, name: docTemplates.name }).from(docTemplates).where(and(eq(docTemplates.clientId, cid), eq(docTemplates.enabled, true))).orderBy(asc(docTemplates.createdAt)),
    db.select({ id: dataTables.id, name: dataTables.name }).from(dataTables).where(and(eq(dataTables.clientId, cid), eq(dataTables.enabled, true))).orderBy(asc(dataTables.createdAt)),
    db.select({ id: loyaltyPrograms.id, name: loyaltyPrograms.name }).from(loyaltyPrograms).where(and(eq(loyaltyPrograms.clientId, cid), eq(loyaltyPrograms.enabled, true))),
    db.select({ tableId: clientPricing.tableId }).from(clientPricing).where(eq(clientPricing.clientId, cid)),
    db.select({ base: clientLogistics.baseAddress }).from(clientLogistics).where(eq(clientLogistics.clientId, cid)),
    db.select({ enabled: clientPayments.enabled }).from(clientPayments).where(eq(clientPayments.clientId, cid)),
    db.select({ coursesCount: count() }).from(courses).where(eq(courses.clientId, cid)),
    getGoogleSettings(),
    getServices(),
  ]);
  const parsed = agentConfigSchema.safeParse(agent.config);
  const config = parsed.success ? parsed.data : agentConfigSchema.parse({ ...agent.config, model: agent.config.model || "anthropic:claude-haiku-5-5" });
  // Голосовые ответы — ключ OpenAI студии или свой ключ клиента
  const voice = await withKeys({ clientId: cid }, async () => speechAvailable());
  const [stats, versionRows, history, coverage] = await Promise.all([
    agentMapStats(agentId, chs.map((c) => c.id)),
    db.select({ version: agentVersions.version, config: agentVersions.config, createdAt: agentVersions.createdAt }).from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.version)).limit(20),
    moduleHistory(agentId),
    testCoverage(agentId),
  ]);
  const fmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: studioTz() });
  const versions = versionRows.flatMap((v) => {
    const c = agentConfigSchema.safeParse(v.config);
    return c.success ? [{ version: v.version, at: fmt.format(v.createdAt), config: c.data }] : [];
  });

  return (
    <AgentMap
      key={agent.version}
      agent={{ id: agent.id, name: agent.name, status: agent.status, version: agent.version, config }}
      clientId={cid}
      channels={chs}
      lists={{ kb: list(kb), tools: list(tools), forms: list(forms), procedures: list(procs), docs: list(docs), tables: list(tables), programs: list(programs) }}
      ready={{
        pricing: Boolean(pricing?.tableId),
        logistics: Boolean(logistics?.base),
        payments: Boolean(pay?.enabled),
        courses: Number(coursesCount) > 0,
        calendar: Boolean(google?.clientEmail),
        webSearch: services.webSearch.enabled,
        voice,
      }}
      models={MODELS.map((m) => ({ id: m.id, label: m.label }))}
      stats={stats}
      versions={versions}
      history={history}
      coverage={coverage}
    />
  );
}

export const instant = false;
