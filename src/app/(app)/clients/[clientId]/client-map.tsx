import { and, asc, count, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientForms, clientLogistics, clientPayments, clientPricing, clientTools, conversations, courses, dataTables, docTemplates, kbSources, loyaltyPrograms, procedures, routingRules } from "@/db/schema";
import { agentConfigSchema, type AgentConfig } from "@/lib/agent/types";
import { getT } from "@/lib/i18n/server";
import { weekAgo } from "@/lib/agent/map-stats";
import { ClientMapView, type ClientMapAgent, type ClientMapResource } from "./client-map-view";

/** Карта клиента: все агенты с каналами и общие ресурсы клиента — кто чем пользуется, что не использует никто. */
export async function ClientMapTab({ clientId }: { clientId: string }) {
  const { locale } = await getT();
  const uk = locale === "uk";
  const since = weekAgo();
  const [agentRows, chs, kb, tools, forms, procs, docs, tables, programs, [pricing], [logistics], [pay], [{ coursesCount }], [{ routing }], conv] = await Promise.all([
    db.select({ id: agents.id, name: agents.name, status: agents.status, config: agents.config }).from(agents).where(eq(agents.clientId, clientId)).orderBy(asc(agents.createdAt)),
    db.select({ agentId: channels.agentId, type: channels.type, name: channels.name, enabled: channels.enabled }).from(channels).where(eq(channels.clientId, clientId)),
    db.select({ id: kbSources.id }).from(kbSources).where(eq(kbSources.clientId, clientId)),
    db.select({ id: clientTools.id }).from(clientTools).where(and(eq(clientTools.clientId, clientId), eq(clientTools.enabled, true))),
    db.select({ id: clientForms.id }).from(clientForms).where(and(eq(clientForms.clientId, clientId), eq(clientForms.enabled, true))),
    db.select({ id: procedures.id }).from(procedures).where(and(eq(procedures.clientId, clientId), eq(procedures.enabled, true))),
    db.select({ id: docTemplates.id }).from(docTemplates).where(and(eq(docTemplates.clientId, clientId), eq(docTemplates.enabled, true))),
    db.select({ id: dataTables.id }).from(dataTables).where(and(eq(dataTables.clientId, clientId), eq(dataTables.enabled, true))),
    db.select({ id: loyaltyPrograms.id }).from(loyaltyPrograms).where(and(eq(loyaltyPrograms.clientId, clientId), eq(loyaltyPrograms.enabled, true))),
    db.select({ tableId: clientPricing.tableId }).from(clientPricing).where(eq(clientPricing.clientId, clientId)),
    db.select({ base: clientLogistics.baseAddress }).from(clientLogistics).where(eq(clientLogistics.clientId, clientId)),
    db.select({ enabled: clientPayments.enabled }).from(clientPayments).where(eq(clientPayments.clientId, clientId)),
    db.select({ coursesCount: count() }).from(courses).where(eq(courses.clientId, clientId)),
    db.select({ routing: count() }).from(routingRules).where(eq(routingRules.clientId, clientId)),
    db
      .select({ agentId: conversations.agentId, n: count() })
      .from(conversations)
      .where(and(eq(conversations.clientId, clientId), eq(conversations.isTest, false), gte(conversations.lastMessageAt, since)))
      .groupBy(conversations.agentId),
  ]);

  const configs = agentRows.map((a) => ({ ...a, cfg: agentConfigSchema.safeParse(a.config) }));
  const cfgOf = (a: (typeof configs)[number]): AgentConfig | null => (a.cfg.success ? a.cfg.data : null);
  const used = (pred: (c: AgentConfig) => boolean) => configs.filter((a) => cfgOf(a) && pred(cfgOf(a)!)).map((a) => a.id);
  const idsUsed = (field: "toolIds" | "formIds" | "procedureIds" | "docTemplateIds" | "tableIds") => new Set(configs.flatMap((a) => cfgOf(a)?.[field] ?? []));
  const unused = (all: { id: string }[], field: Parameters<typeof idsUsed>[0]) => {
    const s = idsUsed(field);
    return all.filter((x) => !s.has(x.id)).length;
  };
  const kbUsed = new Set(configs.flatMap((a) => (cfgOf(a)?.kbSourceIds === null ? kb.map((k) => k.id) : (cfgOf(a)?.kbSourceIds ?? []))));
  const base = `/clients/${clientId}`;
  const L = (ru: string, ukText: string) => (uk ? ukText : ru);

  const resources: ClientMapResource[] = [
    { key: "kb", title: L("База знаний", "База знань"), count: kb.length, unused: kb.filter((k) => !kbUsed.has(k.id)).length, href: `${base}?tab=kb`, usedBy: used((c) => c.kbSourceIds === null || c.kbSourceIds.length > 0), ready: kb.length > 0 },
    { key: "tables", title: L("Таблицы данных", "Таблиці даних"), count: tables.length, unused: unused(tables, "tableIds"), href: `${base}?tab=data`, usedBy: used((c) => Boolean(c.tableIds?.length)), ready: tables.length > 0 },
    { key: "tools", title: L("Инструменты, CRM и MCP", "Інструменти, CRM і MCP"), count: tools.length, unused: unused(tools, "toolIds"), href: `${base}?tab=tools`, usedBy: used((c) => Boolean(c.toolIds?.length)), ready: tools.length > 0 },
    { key: "forms", title: L("Анкеты и тесты", "Анкети й тести"), count: forms.length, unused: unused(forms, "formIds"), href: `${base}?tab=forms`, usedBy: used((c) => Boolean(c.formIds?.length)), ready: forms.length > 0 },
    { key: "procedures", title: L("Процедуры", "Процедури"), count: procs.length, unused: unused(procs, "procedureIds"), href: `${base}?tab=procedures`, usedBy: used((c) => Boolean(c.procedureIds?.length)), ready: procs.length > 0 },
    { key: "docs", title: L("Документы", "Документи"), count: docs.length, unused: unused(docs, "docTemplateIds"), href: `${base}?tab=documents`, usedBy: used((c) => Boolean(c.docTemplateIds?.length)), ready: docs.length > 0 },
    { key: "payments", title: L("Оплата", "Оплата"), count: pay ? 1 : 0, unused: 0, href: `${base}?tab=payments`, usedBy: used((c) => Boolean(c.payments)), ready: Boolean(pay?.enabled) },
    { key: "pricing", title: L("Расчёт цен", "Розрахунок цін"), count: pricing?.tableId ? 1 : 0, unused: 0, href: `${base}?tab=pricing`, usedBy: used((c) => Boolean(c.pricing)), ready: Boolean(pricing?.tableId) },
    { key: "loyalty", title: L("Баллы", "Бали"), count: programs.length, unused: programs.filter((p) => !configs.some((a) => cfgOf(a)?.loyaltyProgramId === p.id)).length, href: `${base}?tab=loyalty`, usedBy: used((c) => Boolean(c.loyaltyProgramId)), ready: programs.length > 0 },
    { key: "learning", title: L("Обучение", "Навчання"), count: Number(coursesCount), unused: 0, href: `${base}?tab=learning`, usedBy: used((c) => Boolean(c.learning)), ready: Number(coursesCount) > 0 },
    { key: "logistics", title: L("Логистика", "Логістика"), count: logistics?.base ? 1 : 0, unused: 0, href: `${base}?tab=logistics`, usedBy: used((c) => Boolean(c.logistics)), ready: Boolean(logistics?.base) },
    { key: "routing", title: L("Распределение заявок", "Розподіл заявок"), count: Number(routing), unused: 0, href: `${base}?tab=routing`, usedBy: Number(routing) ? configs.map((a) => a.id) : [], ready: Number(routing) > 0 },
  ].filter((r) => r.count > 0 || r.usedBy.length > 0);

  const convBy = new Map(conv.map((c) => [c.agentId, Number(c.n)]));
  const mapAgents: ClientMapAgent[] = configs.map((a) => ({
    id: a.id,
    name: a.name,
    icon: cfgOf(a)?.icon ?? "🤖",
    status: a.status,
    conversations: convBy.get(a.id) ?? 0,
    channels: chs.filter((c) => c.agentId === a.id).map((c) => ({ type: c.type, name: c.name, enabled: c.enabled })),
  }));

  return <ClientMapView agents={mapAgents} resources={resources} clientId={clientId} />;
}
