"use server";

import { refresh } from "next/cache";
import { and, count, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { generatePassword, hashPassword } from "@/lib/passwords";

/** Результат операций, где появляется новый пароль: показываем его администратору один раз. */
export type TeamResult = { error?: string; password?: string; email?: string };

const newUserSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["admin", "member"]),
});

export async function addMember(_prev: TeamResult | undefined, formData: FormData): Promise<TeamResult> {
  await requireAdmin();
  const parsed = newUserSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid" };
  const { name, email, role } = parsed.data;

  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (exists) return { error: "email_taken" };

  const password = generatePassword();
  await db.insert(users).values({ name, email, role, passwordHash: await hashPassword(password) });
  refresh();
  return { password, email };
}

export async function resetMemberPassword(userId: string): Promise<TeamResult> {
  await requireAdmin();
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!u) return { error: "not_found" };
  const password = generatePassword();
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, userId));
  return { password, email: u.email };
}

async function otherAdmins(userId: string) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), ne(users.id, userId)));
  return n;
}

export async function setMemberRole(userId: string, role: "admin" | "member"): Promise<TeamResult> {
  const me = await requireAdmin();
  if (userId === me.id) return { error: "self" };
  if (role === "member" && (await otherAdmins(userId)) === 0) return { error: "last_admin" };
  await db.update(users).set({ role }).where(eq(users.id, userId));
  refresh();
  return {};
}

/** Каким клиентам доступен сотрудник: список id или null — всем. */
export async function setMemberClients(userId: string, clientIds: string[] | null): Promise<TeamResult> {
  await requireAdmin();
  const ids = clientIds ? z.array(z.string().max(64)).max(500).parse(clientIds) : null;
  const known = ids ? new Set((await db.select({ id: clients.id }).from(clients)).map((c) => c.id)) : null;
  await db.update(users).set({ clientIds: ids ? ids.filter((i) => known!.has(i)) : null }).where(eq(users.id, userId));
  refresh();
  return {};
}

/** Сотрудник потерял телефон: выключить ему вход с кодом (включит заново в профиле). */
export async function resetMemberTwoFactor(userId: string): Promise<TeamResult> {
  const me = await requireAdmin();
  if (userId === me.id) return { error: "self" };
  await db.update(users).set({ totpEnabled: false, totpSecret: null, recoveryCodes: [] }).where(eq(users.id, userId));
  refresh();
  return {};
}

export async function deleteMember(userId: string): Promise<TeamResult> {
  const me = await requireAdmin();
  if (userId === me.id) return { error: "self" };
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) return {};
  if (u.role === "admin" && (await otherAdmins(userId)) === 0) return { error: "last_admin" };
  await db.delete(users).where(eq(users.id, userId));
  refresh();
  return {};
}
