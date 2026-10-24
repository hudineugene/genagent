import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "./session";

export type CurrentUser = { id: string; name: string; email: string; role: "admin" | "member" | "client"; clientIds: string[] | null; totpEnabled: boolean };

/** Текущий пользователь или null. Дедуплицируется в рамках одного запроса. */
export const findCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  await connection();
  const { userId } = await getSession();
  if (!userId) return null;
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, clientIds: users.clientIds, totpEnabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId));
  return u ?? null;
});

/** Для страниц и server actions студии: без сессии — на /login; владелец бизнеса — в свой кабинет. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await findCurrentUser();
  if (!u) redirect("/login");
  if (u.role === "client") redirect("/portal");
  return u;
}

/** Кабинет клиента: владелец бизнеса (его клиент) или сотрудник студии с доступом (просмотр кабинета). */
export async function requirePortalUser(preview?: string | null): Promise<{ user: CurrentUser; clientId: string; staff: boolean }> {
  const u = await findCurrentUser();
  if (!u) redirect("/login");
  if (u.role === "client") {
    const clientId = u.clientIds?.[0];
    if (!clientId) redirect("/login");
    return { user: u, clientId, staff: false };
  }
  const { canClient } = await import("./access");
  if (!preview || !canClient(u, preview)) redirect("/clients");
  return { user: u, clientId: preview, staff: true };
}

/** Только для администраторов: остальных — на главную. */
export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== "admin") redirect("/");
  return u;
}
