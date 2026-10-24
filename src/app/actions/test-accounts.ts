"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { addTestAccount, applyTestAccounts, getTestAccounts, saveTestAccounts } from "@/lib/test-accounts";

import { requireOwned } from "@/lib/access";
/** Список тестовых аккаунтов (страница «Сотрудники»): сохранить и пометить их старые разговоры. */
export async function saveTestAccountsAction(raw: string): Promise<{ list: string[]; marked: number; bad: string[] }> {
  await requireAdmin();
  const r = await saveTestAccounts(String(raw ?? "").slice(0, 5000));
  refresh();
  return r;
}

/** «Тестовый разговор» в «Диалогах»: пометить (и запомнить аккаунт — его новые разговоры тоже будут тестовыми) или снять. */
export async function setConversationTest(conversationId: string, test: boolean): Promise<{ error?: string }> {
  await requireOwned("conversation", conversationId);
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!c) return { error: "not_found" };
  await db.update(conversations).set({ isTest: test, ...(test ? { needsAttention: false } : {}) }).where(eq(conversations.id, conversationId));
  if (test) {
    // Telegram и свой бот — ID пользователя; почта и соцсети — ник/адрес
    await addTestAccount(/^-?\d+$/.test(c.externalId) ? c.externalId : c.contactHandle || c.externalId);
    await applyTestAccounts(await getTestAccounts());
  }
  refresh();
  return {};
}
