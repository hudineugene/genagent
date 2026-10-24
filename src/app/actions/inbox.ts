"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { addMessage } from "@/lib/conversations";
import { approveDraftCore, rejectDraftCore } from "@/lib/drafts";
import { operatorReplyCore, returnToAgentCore } from "@/lib/operator";
import { forgetClient } from "@/lib/agent/memory";

export type InboxResult = { error?: string };

/** Ответ менеджера. Диалог переходит к менеджеру — агент перестаёт отвечать. */
export async function sendOperatorMessage(conversationId: string, text: string): Promise<InboxResult> {
  const user = await requireUser();
  const r = await operatorReplyCore(conversationId, text, user.id);
  refresh();
  return r;
}

export async function takeOver(conversationId: string): Promise<InboxResult> {
  const user = await requireUser();
  await db.update(conversations).set({ mode: "human" }).where(eq(conversations.id, conversationId));
  await addMessage(conversationId, "system", "took_over", { authorId: user.id });
  refresh();
  return {};
}

/** Вернуть диалог агенту; если последнее сообщение от клиента осталось без ответа — агент ответит. */
export async function returnToAgent(conversationId: string): Promise<InboxResult> {
  const user = await requireUser();
  const r = await returnToAgentCore(conversationId, user.id);
  refresh();
  return r;
}

export async function setConversationStatus(conversationId: string, status: "open" | "closed"): Promise<InboxResult> {
  await requireUser();
  await db
    .update(conversations)
    .set({ status, ...(status === "closed" ? { needsAttention: false, unread: 0 } : {}) })
    .where(eq(conversations.id, conversationId));
  refresh();
  return {};
}

export async function markRead(conversationId: string): Promise<InboxResult> {
  await requireUser();
  await db.update(conversations).set({ unread: 0 }).where(eq(conversations.id, conversationId));
  return {};
}

/** Одобрить черновик ответа агента (можно с правкой) — он публикуется от имени аккаунта. */
export async function approveDraft(messageId: string, text?: string): Promise<InboxResult> {
  const user = await requireUser();
  const r = await approveDraftCore(messageId, { text, userId: user.id });
  refresh();
  return r;
}

export async function rejectDraft(messageId: string): Promise<InboxResult> {
  await requireUser();
  await rejectDraftCore(messageId);
  refresh();
  return {};
}

/** Удалить диалог целиком (со всеми сообщениями). Расходы на модели в аналитике остаются. */
export async function deleteConversation(conversationId: string): Promise<InboxResult> {
  await requireUser();
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  refresh();
  return {};
}

/** Стереть долгую память агента об этом клиенте. */
export async function forgetClientMemory(conversationId: string): Promise<InboxResult> {
  await requireUser();
  await forgetClient(conversationId);
  refresh();
  return {};
}

/** «Проверить ответ» до отправки: оценка, замечания и улучшенный вариант (по правилам и базе знаний агента). */
/** Бриф перед звонком клиенту (на одну страницу). */
export async function callBriefAction(conversationId: string): Promise<{ text?: string; error?: string }> {
  await requireUser();
  try {
    const { callBrief } = await import("@/lib/agent/brief");
    const text = await callBrief(conversationId);
    return text ? { text } : { error: "unavailable" };
  } catch (e) {
    console.error("call brief failed", e);
    return { error: "unavailable" };
  }
}

export async function checkOperatorDraft(conversationId: string, text: string): Promise<{ score: number; problems: string[]; better: string } | { error: string }> {
  await requireUser();
  if (!text.trim()) return { error: "empty" };
  const { reviewReply } = await import("@/lib/agent/operator-review");
  try {
    return (await reviewReply(conversationId, text.trim().slice(0, 4000))) ?? { error: "unavailable" };
  } catch (e) {
    console.error("check operator draft failed", e);
    return { error: "unavailable" };
  }
}

/** Удалить все данные человека у клиента (GDPR, ст. 17): все его разговоры, анкеты, документы, баллы, обучение. */
export async function erasePersonAction(conversationId: string): Promise<InboxResult & { conversations?: number }> {
  await requireUser();
  const { erasePerson } = await import("@/lib/privacy");
  const r = await erasePerson(conversationId);
  refresh();
  return r ? { conversations: r.conversations } : { error: "not_found" };
}
