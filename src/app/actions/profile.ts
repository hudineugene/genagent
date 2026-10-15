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
