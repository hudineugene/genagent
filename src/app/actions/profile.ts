"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "@/lib/passwords";

export type FormResult = { ok?: boolean; error?: string };

export async function updateProfile(_prev: FormResult | undefined, formData: FormData): Promise<FormResult> {
  const me = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 200) return { error: "name" };
  await db.update(users).set({ name }).where(eq(users.id, me.id));
  refresh();
  return { ok: true };
}

export async function changePassword(_prev: FormResult | undefined, formData: FormData): Promise<FormResult> {
  const me = await requireUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (next.length < MIN_PASSWORD_LENGTH) return { error: "too_short" };
  if (next !== confirm) return { error: "mismatch" };

  const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, me.id));
  if (!u || !(await verifyPassword(current, u.hash))) return { error: "wrong_current" };

  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, me.id));
  return { ok: true };
}

export type TwoFactorStart = { qr?: string; secret?: string; error?: string };

/** Начать подключение второго фактора: новый секрет (ещё не включён), QR для приложения. */
export async function startTwoFactor(): Promise<TwoFactorStart> {
  const me = await requireUser();
  const [u] = await db.select({ enabled: users.totpEnabled }).from(users).where(eq(users.id, me.id));
  if (u?.enabled) return { error: "already" };
  const { newSecret, otpauthUri, sealSecret } = await import("@/lib/totp");
  const secret = newSecret();
  await db.update(users).set({ totpSecret: sealSecret(secret), totpEnabled: false }).where(eq(users.id, me.id));
  const QR = await import("qrcode");
  const qr = await QR.toDataURL(otpauthUri(secret, me.email), { margin: 1, width: 220 });
  return { qr, secret };
}

/** Подтвердить кодом из приложения — второй фактор включён, выдаём коды восстановления (показываются один раз). */
export async function confirmTwoFactor(code: string): Promise<{ codes?: string[]; error?: string }> {
  const me = await requireUser();
  const [u] = await db.select({ secret: users.totpSecret, enabled: users.totpEnabled }).from(users).where(eq(users.id, me.id));
  if (!u?.secret || u.enabled) return { error: "invalid" };
  const { newRecoveryCodes, openSecret, verifyTotp } = await import("@/lib/totp");
  if (!verifyTotp(openSecret(u.secret), code)) return { error: "code" };
  const { codes, hashes } = newRecoveryCodes();
  await db.update(users).set({ totpEnabled: true, recoveryCodes: hashes }).where(eq(users.id, me.id));
  refresh();
  return { codes };
}

/** Отключить второй фактор — только с действующим кодом из приложения. */
export async function disableTwoFactor(code: string): Promise<{ error?: string }> {
  const me = await requireUser();
  const [u] = await db.select({ secret: users.totpSecret, enabled: users.totpEnabled }).from(users).where(eq(users.id, me.id));
  if (!u?.secret || !u.enabled) return {};
  const { openSecret, verifyTotp } = await import("@/lib/totp");
  if (!verifyTotp(openSecret(u.secret), code)) return { error: "code" };
  await db.update(users).set({ totpEnabled: false, totpSecret: null, recoveryCodes: [] }).where(eq(users.id, me.id));
  refresh();
  return {};
}
