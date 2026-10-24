"use server";

import { headers } from "next/headers";
import { refresh } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "@/lib/passwords";
import { lockedFor, recordFailure } from "@/lib/login-limit";
import { setSession } from "@/lib/session";

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

  // Другие сессии (украденная или забытая на чужом компьютере) завершаются, эта — остаётся
  const [n] = await db.update(users).set({ passwordHash: await hashPassword(next), sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, me.id)).returning({ v: users.sessionVersion });
  await setSession({ userId: me.id, v: n.v });
  return { ok: true };
}

/** Подбор кода в профиле ограничен так же, как при входе: по почте и адресу. */
async function codeIp() {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}
async function codeLocked(email: string) {
  return lockedFor(email, await codeIp()) > 0;
}
async function codeFailed(email: string): Promise<{ error: string }> {
  recordFailure(email, await codeIp());
  return { error: "code" };
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
  if (await codeLocked(me.email)) return { error: "locked" };
  const { newRecoveryCodes, openSecret, verifyTotp } = await import("@/lib/totp");
  if (!verifyTotp(openSecret(u.secret), code)) return codeFailed(me.email);
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
  if (await codeLocked(me.email)) return { error: "locked" };
  const { openSecret, verifyTotp } = await import("@/lib/totp");
  if (!verifyTotp(openSecret(u.secret), code)) return codeFailed(me.email);
  await db.update(users).set({ totpEnabled: false, totpSecret: null, recoveryCodes: [] }).where(eq(users.id, me.id));
  refresh();
  return {};
}

/** Фото профиля: PNG, JPEG или WEBP до 1 МБ (тип — по содержимому файла). Коды ошибок: empty, too_big, type. */
export async function uploadAvatar(formData: FormData): Promise<{ error?: "empty" | "too_big" | "type" }> {
  const me = await requireUser();
  const f = formData.get("photo");
  if (!(f instanceof File) || f.size === 0) return { error: "empty" };
  const { MAX_AVATAR_BYTES, saveAvatar } = await import("@/lib/avatar");
  if (f.size > MAX_AVATAR_BYTES) return { error: "too_big" };
  const data = Buffer.from(await f.arrayBuffer());
  const { imageType } = await import("@/lib/client-logo");
  if (!imageType(data)) return { error: "type" };
  await saveAvatar(me.id, data);
  refresh();
  return {};
}

export async function removeAvatarAction() {
  const me = await requireUser();
  const { removeAvatar } = await import("@/lib/avatar");
  await removeAvatar(me.id);
  refresh();
}
