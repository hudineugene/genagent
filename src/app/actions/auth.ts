"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { clearSession, setSession } from "@/lib/session";
import { LOCALE_COOKIE, isLocale } from "@/lib/i18n";
import { lockedFor, recordFailure, recordSuccess } from "@/lib/login-limit";

// Для пользователя, которого нет, всё равно сверяем пароль — чтобы по времени ответа нельзя было узнать, есть ли такой email.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

export type LoginState = { error?: "invalid" | "locked"; minutes?: number } | undefined;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 200);
  const password = String(formData.get("password") ?? "");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  const wait = lockedFor(email, ip);
  if (wait) return { error: "locked", minutes: Math.ceil(wait / 60_000) };

  const [user] = await db.select().from(users).where(eq(users.email, email));
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(email, ip);
    const after = lockedFor(email, ip);
    return after ? { error: "locked", minutes: Math.ceil(after / 60_000) } : { error: "invalid" };
  }
  recordSuccess(email, ip);
  await setSession({ userId: user.id });
  redirect("/");
}

export async function logout() {
  await clearSession();
  redirect("/login");
}

export async function setLocale(locale: string) {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  refresh();
}
