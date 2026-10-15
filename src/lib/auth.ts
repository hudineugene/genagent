import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "./session";

export type CurrentUser = { id: string; name: string; email: string; role: "admin" | "member" };

/** Текущий пользователь или null. Дедуплицируется в рамках одного запроса. */
export const findCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  await connection();
  const { userId } = await getSession();
  if (!userId) return null;
  const [u] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  return u ?? null;
});

/** Для страниц и server actions: без сессии — на /login. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await findCurrentUser();
  if (!u) redirect("/login");
  return u;
}

/** Только для администраторов: остальных — на главную. */
export async function requireAdmin(): Promise<CurrentUser> {
  const u = await requireUser();
  if (u.role !== "admin") redirect("/");
  return u;
}
