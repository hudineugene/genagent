"use server";

import { refresh } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, knowledgeGaps, users } from "@/db/schema";
import { findCurrentUser, requireAdmin } from "@/lib/auth";
import { requireClient } from "@/lib/access";
import { generatePassword, hashPassword } from "@/lib/passwords";

/** Владелец бизнеса в своём кабинете (или сотрудник студии с доступом к клиенту). */
async function portalAccess(clientId: string) {
  const u = await findCurrentUser();
  if (!u) throw new Error("unauthorized");
  if (u.role === "client") {
    if (u.clientIds?.[0] !== clientId) throw new Error("forbidden");
    return u;
  }
  return requireClient(clientId);
}

/** Ответ владельца клиенту из кабинета (разговор переходит к людям, как ответ менеджера). */
export async function portalReply(conversationId: string, text: string): Promise<{ error?: string }> {
  const [c] = await db.select({ clientId: conversations.clientId }).from(conversations).where(eq(conversations.id, conversationId));
  if (!c) return { error: "not_found" };
  const u = await portalAccess(c.clientId);
  const body = z.string().trim().min(1).max(4000).safeParse(text);
  if (!body.success) return { error: "empty" };
  const { operatorReplyCore } = await import("@/lib/operator");
  const r = await operatorReplyCore(conversationId, body.data, u.id);
  refresh();
  return r;
}

/** Ответ владельца на вопрос без ответа — в базу знаний агента. */
export async function portalAnswerGap(gapId: string, answer: string): Promise<{ error?: string }> {
  const [g] = await db.select({ clientId: knowledgeGaps.clientId }).from(knowledgeGaps).where(eq(knowledgeGaps.id, gapId));
  if (!g) return { error: "not_found" };
  const u = await portalAccess(g.clientId);
  const text = z.string().trim().min(2).max(4000).safeParse(answer);
  if (!text.success) return { error: "answer_short" };
  const { addAnswerToKb } = await import("@/lib/agent/kb-answers");
  const r = await addAnswerToKb(gapId, text.data, u.id);
  refresh();
  return r.error ? { error: r.error } : {};
}

// ---------- вход владельцев бизнеса (выдаёт студия) ----------

export type OwnerLoginResult = { error?: string; email?: string; password?: string };

export async function addOwnerLogin(clientId: string, input: { name: string; email: string }): Promise<OwnerLoginResult> {
  await requireClient(clientId);
  const d = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().toLowerCase().email() }).safeParse(input);
  if (!d.success) return { error: "invalid" };
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, d.data.email));
  if (exists) return { error: "email_taken" };
  const password = generatePassword();
  await db.insert(users).values({ name: d.data.name, email: d.data.email, role: "client", clientIds: [clientId], passwordHash: await hashPassword(password) });
  refresh();
  return { email: d.data.email, password };
}

export async function resetOwnerLogin(userId: string): Promise<OwnerLoginResult> {
  const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.role, "client")));
  if (!u) return { error: "not_found" };
  await requireClient(u.clientIds?.[0] ?? "");
  const password = generatePassword();
  await db.update(users).set({ passwordHash: await hashPassword(password), totpEnabled: false, totpSecret: null, recoveryCodes: [], sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, userId));
  return { email: u.email, password };
}

export async function deleteOwnerLogin(userId: string) {
  const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.role, "client")));
  if (!u) return;
  await requireClient(u.clientIds?.[0] ?? "");
  await db.delete(users).where(and(eq(users.id, userId), ne(users.role, "admin")));
  refresh();
}

/** Бренд студии для кабинета и входа (только администратор). */
export async function saveBrandAction(input: { name: string; color: string; logo: string; support: string }): Promise<{ error?: string }> {
  await requireAdmin();
  const d = z
    .object({
      name: z.string().trim().min(1).max(60),
      color: z.string().trim().regex(/^#[0-9a-f]{6}$/i),
      logo: z.string().trim().max(500).refine((v) => !v || /^https:\/\//.test(v) || [...v].length <= 4, "logo"),
      support: z.string().trim().max(200),
    })
    .safeParse(input);
  if (!d.success) return { error: "invalid" };
  const { saveBrand } = await import("@/lib/whitelabel");
  await saveBrand(d.data);
  refresh();
  return {};
}
