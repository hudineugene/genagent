import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages } from "@/db/schema";
import { deliver } from "@/lib/conversations";

/**
 * Черновики ответов (письма, публичные комментарии): опубликовать или отклонить.
 * Общая логика для «Диалогов» и кнопок в уведомлениях Telegram.
 */
export async function approveDraftCore(messageId: string, opts: { text?: string; userId?: string } = {}): Promise<{ error?: string }> {
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.status, "draft")));
  if (!m) return { error: "not_found" };
  const [row] = await db
    .select({ conversation: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, m.conversationId));
  if (!row) return { error: "not_found" };
  const body = (opts.text ?? m.text).trim();
  if (!body) return { error: "empty" };
  let externalId: string | null;
  try {
    externalId = await deliver(row.channel, row.conversation, body);
  } catch (e) {
    console.error("draft deliver failed", e);
    return { error: e instanceof Error ? e.message : String(e) };
  }
  await db
    .update(messages)
    .set({ status: "sent", text: body, externalId, authorId: body !== m.text && opts.userId ? opts.userId : m.authorId })
    .where(eq(messages.id, messageId));
  await db
    .update(conversations)
    .set({ needsAttention: false, unread: 0, lastMessageText: body.slice(0, 200), lastMessageAt: new Date() })
    .where(eq(conversations.id, m.conversationId));
  return {};
}

export async function rejectDraftCore(messageId: string): Promise<{ error?: string }> {
  const [m] = await db
    .update(messages)
    .set({ status: "rejected" })
    .where(and(eq(messages.id, messageId), eq(messages.status, "draft")))
    .returning({ conversationId: messages.conversationId });
  if (!m) return { error: "not_found" };
  await db.update(conversations).set({ needsAttention: false }).where(eq(conversations.id, m.conversationId));
  return {};
}
