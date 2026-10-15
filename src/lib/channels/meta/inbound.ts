import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  channels,
  conversations,
  messages,
  type Channel,
  type ConversationContext,
  type InstagramConfig,
  type ThreadsConfig,
} from "@/db/schema";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";

/**
 * Входящие из Instagram и Threads — одинаково для вебхуков и периодической проверки:
 * повторы отсекаются по id сообщения в соцсети, свои ответы аккаунта игнорируются.
 */

async function seen(channelId: string, externalId: string) {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.channelId, channelId), eq(messages.externalId, externalId)))
    .limit(1);
  return Boolean(row);
}

/** Диалог, в котором уже есть сообщение с этим id (чтобы продолжить ветку ответов). */
async function conversationByMessage(channelId: string, externalId: string) {
  const [row] = await db
    .select({ conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.channelId, channelId), eq(messages.externalId, externalId)))
    .limit(1);
  return row?.conversation;
}

export async function findChannelByAccount(type: "instagram" | "threads", accountId: string) {
  const field = type === "instagram" ? "$.igUserId" : "$.threadsUserId";
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, type), eq(channels.enabled, true), sql`json_extract(${channels.config}, ${field}) = ${accountId}`));
  return ch;
}

// ---------- Instagram ----------

export async function handleInstagramDm(
  channel: Channel,
  ev: { senderId: string; mid: string; text: string; username?: string },
) {
  const cfg = channel.config as InstagramConfig;
  if (!cfg.dm || ev.senderId === cfg.igUserId) return; // директ выключен или это наше же сообщение
  if (await seen(channel.id, ev.mid)) return;
  const { conversation } = await upsertConversation(channel, `dm:${ev.senderId}`, {
    handle: ev.username ? `@${ev.username}` : "",
  });
  await addMessage(conversation.id, "user", ev.text || "[вложение]", { externalId: ev.mid });
  scheduleReply(conversation.id);
}

export async function handleInstagramComment(
  channel: Channel,
  ev: {
    id: string;
    text: string;
    fromId?: string;
    username?: string;
    parentId?: string;
    mediaId?: string;
    postUrl?: string;
    postText?: string;
  },
) {
  const cfg = channel.config as InstagramConfig;
  if (!cfg.comments || (ev.fromId && ev.fromId === cfg.igUserId) || (ev.username && ev.username === cfg.username)) return;
  if (await seen(channel.id, ev.id)) return;

  // Ответ в ветке, где мы уже общаемся, — продолжаем тот же диалог (Instagram отвечает только на верхний комментарий).
  const existing = ev.parentId ? await conversationByMessage(channel.id, ev.parentId) : undefined;
  let conversationId: string;
  if (existing) {
    conversationId = existing.id;
  } else {
    const root = ev.parentId ?? ev.id;
    const context: ConversationContext = { postId: ev.mediaId, postUrl: ev.postUrl, postText: ev.postText?.slice(0, 500), replyToId: root };
    const { conversation, created } = await upsertConversation(channel, `c:${root}`, {
      handle: ev.username ? `@${ev.username}` : "",
    });
    if (created) await db.update(conversations).set({ kind: "comment", context }).where(eq(conversations.id, conversation.id));
    conversationId = conversation.id;
  }
  await addMessage(conversationId, "user", ev.text, { externalId: ev.id });
  scheduleReply(conversationId);
}

// ---------- Threads ----------

export async function handleThreadsReply(
  channel: Channel,
  ev: {
    id: string;
    text?: string;
    username?: string;
    owned?: boolean;
    repliedToId?: string;
    rootPostId?: string;
    postUrl?: string;
    postText?: string;
  },
) {
  const cfg = channel.config as ThreadsConfig;
  if (ev.owned || (ev.username && ev.username === cfg.username) || !ev.text) return;
  if (await seen(channel.id, ev.id)) return;

  const existing = ev.repliedToId ? await conversationByMessage(channel.id, ev.repliedToId) : undefined;
  let conversationId: string;
  if (existing) {
    conversationId = existing.id;
    // В Threads отвечаем на последнее сообщение собеседника — так ветка остаётся связной.
    await db
      .update(conversations)
      .set({ context: { ...existing.context, replyToId: ev.id } })
      .where(eq(conversations.id, existing.id));
  } else {
    const context: ConversationContext = {
      postId: ev.rootPostId,
      postUrl: ev.postUrl,
      postText: ev.postText?.slice(0, 500),
      replyToId: ev.id,
    };
    const { conversation, created } = await upsertConversation(channel, `r:${ev.id}`, {
      handle: ev.username ? `@${ev.username}` : "",
    });
    if (created) await db.update(conversations).set({ kind: "comment", context }).where(eq(conversations.id, conversation.id));
    conversationId = conversation.id;
  }
  await addMessage(conversationId, "user", ev.text, { externalId: ev.id });
  scheduleReply(conversationId);
}
