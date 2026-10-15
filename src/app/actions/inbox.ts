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
