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
import { getSession } from "@/lib/session";

// Для пользователя, которого нет, всё равно сверяем пароль — чтобы по времени ответа нельзя было узнать, есть ли такой email.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

export type LoginState = { error?: "invalid" | "locked" | "code"; minutes?: number; step?: "code" } | undefined;

const PENDING_MS = 10 * 60_000;

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
  // Включён второй фактор — вход только после кода из приложения
  if (user.totpEnabled && user.totpSecret) {
    await setSession({ pending: { userId: user.id, at: Date.now() } });
    return { step: "code" };
  }
  recordSuccess(email, ip);
  await setSession({ userId: user.id });
  redirect(user.role === "client" ? "/portal" : "/");
}

/** Второй шаг входа: 6 цифр из приложения-аутентификатора или код восстановления (одноразовый). */
export async function loginCode(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const code = String(formData.get("code") ?? "").trim().slice(0, 20);
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const { pending } = await getSession();
  if (!pending || Date.now() - pending.at > PENDING_MS) return { error: "invalid" };
  const [user] = await db.select().from(users).where(eq(users.id, pending.userId));
  if (!user?.totpSecret) return { error: "invalid" };
  const wait = lockedFor(user.email, ip);
  if (wait) return { error: "locked", minutes: Math.ceil(wait / 60_000), step: "code" };
  const { consumeRecoveryCode, openSecret, verifyTotp } = await import("@/lib/totp");
  let ok = verifyTotp(openSecret(user.totpSecret), code);
  if (!ok && code.length >= 8) {
    const rest = consumeRecoveryCode(user.recoveryCodes, code);
    if (rest) {
      await db.update(users).set({ recoveryCodes: rest }).where(eq(users.id, user.id));
      ok = true;
    }
  }
  if (!ok) {
    recordFailure(user.email, ip);
    const after = lockedFor(user.email, ip);
    return after ? { error: "locked", minutes: Math.ceil(after / 60_000), step: "code" } : { error: "code", step: "code" };
  }
  recordSuccess(user.email, ip);
  await setSession({ userId: user.id });
  redirect(user.role === "client" ? "/portal" : "/");
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
