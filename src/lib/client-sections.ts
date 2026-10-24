import "server-only";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvals, campaigns, clientDocTypes, clientForms, clientIntegrations, clientLogistics, clientPayments, clientPricing, clientRepeat, clientTools, contactLists, contentItems, courses, dataTables, docTemplates, incidents, kbSources, loyaltyPrograms, meetings, monitors, onboardings, procedures, reminders, routines, routingRules, vacancies } from "@/db/schema";
import { hasTeamAgents } from "@/lib/team/approvals";
import type { Dict } from "@/lib/i18n";
import type { NavIcon, SectionGroup, SectionItem } from "@/lib/nav-icons";

/** Раздел клиента: группа, ключ (?tab=), значок, сколько настроено, сколько агентов пользуется, тревога (ждут решения). */
export type ModuleCard = { group: "agent" | "sales" | "ops" | "people"; key: string; icon: NavIcon; title: string; text: string; n: number; used: number; badge?: number; agentless?: boolean };

export const CLIENT_TABS = ["kb", "data", "modules", "map", "outreach", "routing", "pricing", "payments", "reminders", "repeat", "onboarding", "hiring", "monitor", "learning", "tools", "forms", "procedures", "documents", "loyalty", "logistics", "approvals", "campaigns", "content", "meetings", "routines"] as const;

/**
 * Все разделы клиента со счётчиками — для меню разделов (страница клиента и панель слева) и каталога «Все разделы».
 * В меню показываются только настроенные разделы, открытый сейчас и с тревогой (always — показывать всегда).
 */
export async function clientSections(clientId: string, t: Dict) {
  const [[{ agentsCount }], [{ kbCount }], [{ toolsCount }], [{ campaignsCount }], [{ formsCount }], [{ routinesCount }], [{ docTypesCount }], [{ templatesCount }], [{ tablesCount }], [{ pendingApprovals }], [{ approvalsCount }], teamAgents, [{ contentCount }], [{ meetingsCount }], [{ programsCount }], [{ outsCount }], [logistics], agentConfigs, [{ routingCount }], [pricingRow], [{ remindersCount }], [{ onboardingCount }], [{ vacanciesCount }], [{ monitorsCount }], [{ openIncidents }], [{ coursesCount }], [{ outreachCount }], [repeatRow], [payRow], [{ procCount }]] = await Promise.all([
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
    db.select({ remindersCount: count() }).from(reminders).where(eq(reminders.clientId, clientId)),
    db.select({ onboardingCount: count() }).from(onboardings).where(and(eq(onboardings.clientId, clientId), eq(onboardings.status, "active"))),
    db.select({ vacanciesCount: count() }).from(vacancies).where(eq(vacancies.clientId, clientId)),
    db.select({ monitorsCount: count() }).from(monitors).where(eq(monitors.clientId, clientId)),
    db.select({ openIncidents: count() }).from(incidents).where(and(eq(incidents.clientId, clientId), eq(incidents.status, "open"))),
    db.select({ coursesCount: count() }).from(courses).where(eq(courses.clientId, clientId)),
    db.select({ outreachCount: count() }).from(contactLists).where(eq(contactLists.clientId, clientId)),
    db.select({ tableId: clientRepeat.tableId }).from(clientRepeat).where(eq(clientRepeat.clientId, clientId)),
    db.select({ provider: clientPayments.provider }).from(clientPayments).where(eq(clientPayments.clientId, clientId)),
    db.select({ procCount: count() }).from(procedures).where(eq(procedures.clientId, clientId)),
  ]);

  const used = (f: (c: (typeof agentConfigs)[number]["config"]) => boolean) => agentConfigs.filter((a) => f(a.config)).length;
  const sections: ModuleCard[] = [
    { group: "agent", key: "tools", icon: "wrench", title: t.tools.tab, text: t.ws.mod.tools, n: toolsCount + outsCount, used: used((c) => Boolean(c.toolIds?.length)) },
    { group: "agent", key: "forms", icon: "clipboardList", title: t.forms.tab, text: t.ws.mod.forms, n: formsCount, used: used((c) => Boolean(c.formIds?.length)) },
    { group: "agent", key: "procedures", icon: "listChecks", title: t.procedures.tab, text: t.ws.mod.procedures, n: procCount, used: used((c) => Boolean(c.procedureIds?.length)) },
    { group: "agent", key: "documents", icon: "fileText", title: t.documents.tab, text: t.ws.mod.documents, n: docTypesCount + templatesCount, used: used((c) => Boolean(c.docTemplateIds?.length)) },
    { group: "agent", key: "loyalty", icon: "gift", title: t.loyalty.tab, text: t.ws.mod.loyalty, n: programsCount, used: used((c) => Boolean(c.loyaltyProgramId)) },
    { group: "agent", key: "pricing", icon: "calculator", title: t.pricing.tab, text: t.ws.mod.pricing, n: pricingRow?.tableId ? 1 : 0, used: used((c) => Boolean(c.pricing)) },
    { group: "agent", key: "logistics", icon: "truck", title: t.logistics.tab, text: t.ws.mod.logistics, n: logistics?.base ? 1 : 0, used: used((c) => Boolean(c.logistics)) },
    { group: "agent", key: "routing", icon: "route", title: t.routing.tab, text: t.ws.mod.routing, n: routingCount, used: 0, agentless: true },
    { group: "sales", key: "payments", icon: "creditCard", title: t.payments.tab, text: t.ws.mod.payments, n: payRow ? 1 : 0, used: used((c) => Boolean(c.payments)) },
    { group: "sales", key: "campaigns", icon: "megaphone", title: t.campaigns.tab, text: t.ws.mod.campaigns, n: campaignsCount, used: 0, agentless: true },
    { group: "sales", key: "outreach", icon: "mail", title: t.outreach.tab, text: t.ws.mod.outreach, n: outreachCount, used: 0, agentless: true },
    { group: "sales", key: "reminders", icon: "bellRing", title: t.reminders.tab, text: t.ws.mod.reminders, n: remindersCount, used: 0, agentless: true },
    { group: "sales", key: "repeat", icon: "repeat", title: t.repeat.tab, text: t.ws.mod.repeat, n: repeatRow?.tableId ? 1 : 0, used: 0, agentless: true },
    { group: "sales", key: "content", icon: "penLine", title: t.content.tab, text: t.ws.mod.content, n: contentCount, used: 0, agentless: true },
    { group: "ops", key: "meetings", icon: "mic", title: t.meetings.tab, text: t.ws.mod.meetings, n: meetingsCount, used: 0, agentless: true },
    { group: "ops", key: "routines", icon: "fileBarChart", title: t.routines.tab, text: t.ws.mod.routines, n: routinesCount, used: 0, agentless: true },
    { group: "ops", key: "monitor", icon: "activity", title: t.monitor.tab, text: t.ws.mod.monitor, n: monitorsCount, used: 0, agentless: true, badge: openIncidents },
    { group: "people", key: "approvals", icon: "clipboardCheck", title: t.ws.mod.teamTitle, text: t.ws.mod.team, n: teamAgents ? 1 : approvalsCount, used: used((c) => Boolean(c.team?.enabled)), badge: pendingApprovals },
    { group: "people", key: "onboarding", icon: "graduationCap", title: t.onboarding.tab, text: t.ws.mod.onboarding, n: onboardingCount, used: 0, agentless: true },
    { group: "people", key: "hiring", icon: "users", title: t.hiring.tab, text: t.ws.mod.hiring, n: vacanciesCount, used: 0, agentless: true },
    { group: "people", key: "learning", icon: "bookOpenCheck", title: t.learning.tab, text: t.ws.mod.learning, n: coursesCount, used: used((c) => Boolean(c.learning)) },
  ];
  const of = (g: ModuleCard["group"]): SectionItem[] =>
    sections.filter((m) => m.group === g).map((m) => ({ key: m.key, label: m.title, icon: m.icon, n: m.n || undefined, alert: m.badge || undefined }));
  const nav: SectionGroup[] = [
    {
      tone: "bg-accent/10 text-accent",
      items: [
        { key: "agents", label: t.ws.overview, icon: "layoutDashboard", n: agentsCount, always: true },
        { key: "modules", label: t.ws.catalog, icon: "blocks", n: sections.filter((m) => m.n > 0).length, always: true },
        { key: "map", label: t.help.mapTab, icon: "network", always: true },
      ],
    },
    {
      title: t.ws.knowledge,
      tone: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
      items: [
        { key: "kb", label: t.kb.tab, icon: "bookOpen", n: kbCount, always: true },
        { key: "data", label: t.data.tab, icon: "table", n: tablesCount, always: true },
      ],
    },
    { title: t.ws.groups.agent, tone: "bg-violet-500/10 text-violet-600 dark:text-violet-300", items: of("agent") },
    { title: t.ws.groups.sales, tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300", items: of("sales") },
    { title: t.ws.groups.ops, tone: "bg-orange-500/10 text-orange-600 dark:text-orange-300", items: of("ops") },
    { title: t.ws.groups.people, tone: "bg-pink-500/10 text-pink-600 dark:text-pink-300", items: of("people") },
  ];
  return { sections, nav };
}
