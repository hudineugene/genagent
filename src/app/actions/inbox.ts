"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, type ApiConfig } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { addMessage, deliver, scheduleReply } from "@/lib/conversations";
import { approveDraftCore, rejectDraftCore } from "@/lib/drafts";

export type InboxResult = { error?: string };

async function load(conversationId: string) {
  const [row] = await db
    .select({ conversation: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  return row;
}

/** Ответ менеджера. Диалог переходит к менеджеру — агент перестаёт отвечать. */
export async function sendOperatorMessage(conversationId: string, text: string): Promise<InboxResult> {
  const user = await requireUser();
  const body = text.trim();
  if (!body) return { error: "empty" };
  const row = await load(conversationId);
  if (!row) return { error: "not_found" };
  // Свой бот: менеджер отвечает клиенту в самом боте — студия до клиента не достаёт.
  // Свой бот: ответ встаёт в очередь (/outbox), бот отправит его клиенту своим именем —
  // комментарии публикует всегда, личные сообщения — если бот умеет забирать ответы менеджера.
  if (row.channel.type === "api" && row.conversation.kind !== "comment" && !(row.channel.config as ApiConfig).dmAt) {
    return { error: "api_reply_in_bot" };
  }

  if (row.conversation.mode !== "human") {
    await db.update(conversations).set({ mode: "human" }).where(eq(conversations.id, conversationId));
    await addMessage(conversationId, "system", "took_over", { authorId: user.id });
  }
  let externalId: string | null;
  try {
    externalId = await deliver(row.channel, row.conversation, body);
  } catch (e) {
    console.error("operator deliver failed", e);
    refresh();
    return { error: e instanceof Error ? e.message : String(e) };
  }
  await addMessage(conversationId, "operator", body, { authorId: user.id, externalId: externalId ?? undefined });
  await db
    .update(conversations)
    .set({ needsAttention: false, unread: 0, status: "open" })
    .where(eq(conversations.id, conversationId));
  refresh();
  return {};
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
  await db
    .update(conversations)
    .set({ mode: "ai", needsAttention: false })
    .where(eq(conversations.id, conversationId));
  await addMessage(conversationId, "system", "returned", { authorId: user.id });
  // Свой бот узнает об этом из очереди (/outbox, resume) и сам передаст агенту следующий вопрос клиента.
  const [ch] = await db
    .select({ type: channels.type })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  if (ch?.type !== "api") scheduleReply(conversationId);
  refresh();
  return {};
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
