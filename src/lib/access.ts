import "server-only";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "@/db";
import * as s from "@/db/schema";
import { requireUser, type CurrentUser } from "./auth";

/**
 * Доступ сотрудника к клиентам: администратор и сотрудник без ограничений видят всех (без лишних запросов),
 * сотрудник со списком — только своих клиентов. Проверка — в каждом действии по его первому аргументу (клиент,
 * агент, канал, разговор или запись модуля), страницы и списки фильтруются по scope.
 */
export class ForbiddenError extends Error {
  constructor() {
    super("forbidden");
  }
}

/** Клиенты, доступные пользователю; null — все. */
export function scopeOf(user: Pick<CurrentUser, "role" | "clientIds">): string[] | null {
  return user.role === "admin" || !user.clientIds ? null : user.clientIds;
}

export async function scope() {
  return scopeOf(await requireUser());
}

/** Условие для запросов списков: колонка clientId в доступных клиентах (или без условия). */
export function inScope(col: SQLiteColumn, ids: string[] | null): SQL | undefined {
  if (!ids) return undefined;
  return ids.length ? inArray(col, ids) : sql`0`;
}

export function canClient(user: Pick<CurrentUser, "role" | "clientIds">, clientId: string | null | undefined) {
  const ids = scopeOf(user);
  return !ids || (Boolean(clientId) && ids.includes(clientId!));
}

/** Действие над клиентом: нет доступа — ошибка. */
export async function requireClient(clientId: string) {
  const user = await requireUser();
  if (!canClient(user, clientId)) throw new ForbiddenError();
  return user;
}

type Table = SQLiteTable & { id: SQLiteColumn; clientId: SQLiteColumn };

/** Записи модулей, где клиент указан прямо */
const DIRECT = {
  agent: s.agents,
  channel: s.channels,
  conversation: s.conversations,
  tool: s.clientTools,
  integration: s.clientIntegrations,
  campaign: s.campaigns,
  form: s.clientForms,
  routine: s.routines,
  docType: s.clientDocTypes,
  document: s.clientDocuments,
  docTemplate: s.docTemplates,
  dataTable: s.dataTables,
  approval: s.approvals,
  content: s.contentItems,
  meeting: s.meetings,
  contactList: s.contactLists,
  outreach: s.outreach,
  routingRule: s.routingRules,
  payment: s.payments,
  reminder: s.reminders,
  plan: s.onboardingPlans,
  onboarding: s.onboardings,
  vacancy: s.vacancies,
  candidate: s.candidates,
  trip: s.trips,
  monitor: s.monitors,
  incident: s.incidents,
  course: s.courses,
  loyaltyProgram: s.loyaltyPrograms,
  kbSource: s.kbSources,
  gap: s.knowledgeGaps,
  procedure: s.procedures,
} satisfies Record<string, Table>;

export type Kind = keyof typeof DIRECT | "message" | "lesson" | "loyaltyAccount" | "outreachMessage" | "scenario";

/** Клиент записи (null — записи нет). */
export async function clientOf(kind: Kind, id: string): Promise<string | null> {
  if (kind === "message") {
    const [r] = await db.select({ c: s.conversations.clientId }).from(s.messages).innerJoin(s.conversations, eq(s.conversations.id, s.messages.conversationId)).where(eq(s.messages.id, id));
    return r?.c ?? null;
  }
  if (kind === "lesson") {
    const [r] = await db.select({ c: s.courses.clientId }).from(s.lessons).innerJoin(s.courses, eq(s.courses.id, s.lessons.courseId)).where(eq(s.lessons.id, id));
    return r?.c ?? null;
  }
  if (kind === "loyaltyAccount") {
    const [r] = await db.select({ c: s.loyaltyPrograms.clientId }).from(s.loyaltyAccounts).innerJoin(s.loyaltyPrograms, eq(s.loyaltyPrograms.id, s.loyaltyAccounts.programId)).where(eq(s.loyaltyAccounts.id, id));
    return r?.c ?? null;
  }
  if (kind === "outreachMessage") {
    const [r] = await db.select({ c: s.outreach.clientId }).from(s.outreachMessages).innerJoin(s.outreach, eq(s.outreach.id, s.outreachMessages.outreachId)).where(eq(s.outreachMessages.id, id));
    return r?.c ?? null;
  }
  if (kind === "scenario") {
    const [r] = await db.select({ c: s.agents.clientId }).from(s.testScenarios).innerJoin(s.agents, eq(s.agents.id, s.testScenarios.agentId)).where(eq(s.testScenarios.id, id));
    return r?.c ?? null;
  }
  const t = DIRECT[kind] as unknown as typeof s.agents;
  const [r] = await db.select({ c: t.clientId }).from(t).where(eq(t.id, id));
  return r?.c ?? null;
}

/**
 * Действие над записью: доступ к её клиенту. Ограничений нет — без запроса. Записи нет — пропускаем
 * (действие само ответит «не найдено»).
 */
export async function requireOwned(kind: Kind, id: string | null | undefined) {
  const user = await requireUser();
  if (!scopeOf(user) || !id) return user;
  const clientId = await clientOf(kind, id);
  if (clientId && !canClient(user, clientId)) throw new ForbiddenError();
  return user;
}

/** Действие клиента над его записью (сохранить с id): доступ к клиенту, и запись — того же клиента. */
export async function requireClientAnd(clientId: string, kind: Kind, id: string | null | undefined) {
  const user = await requireClient(clientId);
  if (scopeOf(user) && id) {
    const c = await clientOf(kind, id);
    if (c && c !== clientId) throw new ForbiddenError();
  }
  return user;
}

/** Студийные действия без привязки к клиенту (новый клиент): только без ограничений по клиентам. */
export async function requireUnscoped() {
  const user = await requireUser();
  if (scopeOf(user)) throw new ForbiddenError();
  return user;
}

/** Для адресов API (без исключений): вошёл ли пользователь и есть ли у него доступ к клиенту или записи. */
export async function canAccess(kind: Kind | "client", id: string | null | undefined): Promise<boolean> {
  const { findCurrentUser } = await import("./auth");
  const user = await findCurrentUser();
  if (!user) return false;
  if (!scopeOf(user)) return true;
  if (!id) return false;
  const clientId = kind === "client" ? id : await clientOf(kind, id);
  return canClient(user, clientId);
}

/** Для страниц: нет доступа к клиенту или записи — «не найдено» (до того, как страница что-то покажет). */
export async function guardPage(kind: Kind | "client", id: string) {
  if (!(await canAccess(kind, id))) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
}
