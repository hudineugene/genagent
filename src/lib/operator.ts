import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, type ApiConfig } from "@/db/schema";
import { addMessage, deliver, scheduleReply } from "@/lib/conversations";

/**
 * Ответ сотрудника клиенту и возврат диалога агенту — общая логика для «Диалогов» и бота уведомлений в Telegram
 * (сотрудник отвечает с телефона прямо из уведомления).
 */
async function load(conversationId: string) {
  const [row] = await db
    .select({ conversation: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  return row;
}

/** Можно ли ответить клиенту отсюда (свой бот без очереди ответов — менеджер отвечает в самом боте). */
export function canReply(channel: { type: string; config: unknown }, kind: string) {
  return !(channel.type === "api" && kind !== "comment" && !(channel.config as ApiConfig).dmAt);
}

/** Ответ сотрудника. Диалог переходит к сотруднику — агент перестаёт отвечать. */
export async function operatorReplyCore(conversationId: string, text: string, userId?: string): Promise<{ error?: string }> {
  const body = text.trim();
  if (!body) return { error: "empty" };
  const row = await load(conversationId);
  if (!row) return { error: "not_found" };
  // Свой бот: ответ встаёт в очередь (/outbox), бот отправит его клиенту своим именем —
  // комментарии публикует всегда, личные сообщения — если бот умеет забирать ответы менеджера.
  if (!canReply(row.channel, row.conversation.kind)) return { error: "api_reply_in_bot" };

  if (row.conversation.mode !== "human") {
    await db.update(conversations).set({ mode: "human" }).where(eq(conversations.id, conversationId));
    await addMessage(conversationId, "system", "took_over", { authorId: userId });
  }
  let externalId: string | null;
  try {
    externalId = await deliver(row.channel, row.conversation, body);
  } catch (e) {
    console.error("operator deliver failed", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
  await addMessage(conversationId, "operator", body, { authorId: userId, externalId: externalId ?? undefined });
  const ctx = row.conversation.context;
  await db
    .update(conversations)
    .set({ needsAttention: false, unread: 0, status: "open", ...(ctx?.managerDraft ? { context: { ...ctx, managerDraft: undefined } } : {}) })
    .where(eq(conversations.id, conversationId));
  return {};
}

/** Вернуть диалог агенту; если последнее сообщение клиента осталось без ответа — агент ответит. */
export async function returnToAgentCore(conversationId: string, userId?: string): Promise<{ error?: string }> {
  const row = await load(conversationId);
  if (!row) return { error: "not_found" };
  await db.update(conversations).set({ mode: "ai", needsAttention: false }).where(eq(conversations.id, conversationId));
  await addMessage(conversationId, "system", "returned", { authorId: userId });
  // Свой бот узнает об этом из очереди (/outbox, resume) и сам передаст агенту следующий вопрос клиента.
  if (row.channel.type !== "api") scheduleReply(conversationId);
  return {};
}
