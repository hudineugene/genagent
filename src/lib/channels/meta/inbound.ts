import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  channels,
  conversations,
  messages,
  type Channel,
  type ConversationContext,
  type ConversationSource,
  type IgTrigger,
  type InstagramConfig,
  type ThreadsConfig,
} from "@/db/schema";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";
import { jsonText } from "@/db/dialect";

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
  const field = type === "instagram" ? "igUserId" : "threadsUserId";
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, type), eq(channels.enabled, true), sql`${jsonText(channels.config, field)} = ${accountId}`));
  return ch;
}

// ---------- Instagram ----------

/** Запомнить, откуда пришёл клиент (реклама важнее прежнего источника; остальное — только если источника ещё нет). */
export async function setSource(conversation: { id: string; context: ConversationContext | null }, source: ConversationSource) {
  const cur = conversation.context?.source;
  if (cur && source.kind !== "ad") return;
  const [fresh] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversation.id));
  await db.update(conversations).set({ context: { ...fresh?.context, source } }).where(eq(conversations.id, conversation.id));
}

export async function handleInstagramDm(
  channel: Channel,
  ev: { senderId: string; mid: string; text: string; username?: string; source?: ConversationSource },
) {
  const cfg = channel.config as InstagramConfig;
  if (!cfg.dm || ev.senderId === cfg.igUserId) return; // директ выключен или это наше же сообщение
  if (ev.mid && (await seen(channel.id, ev.mid))) return;
  const { conversation } = await upsertConversation(channel, `dm:${ev.senderId}`, {
    handle: ev.username ? `@${ev.username}` : "",
  });
  if (ev.source) await setSource(conversation, ev.source);
  // Переход по рекламе или ссылке без сообщения — только запоминаем источник
  if (!ev.mid) return;
  await addMessage(conversation.id, "user", ev.text || "[вложение]", { externalId: ev.mid });
  scheduleReply(conversation.id);
}

type IgIncoming = {
  text?: string;
  attachments?: { type?: string; payload?: { url?: string } }[];
  reply_to?: { story?: { url?: string; id?: string } };
  referral?: { ref?: string; source?: string; ad_id?: string; ads_context_data?: { ad_title?: string } };
};

/** Текст директа с пометками (ответ на историю, упоминание в истории) и источник клиента (реклама, ссылка с меткой, история). */
export function igSource(m: IgIncoming | undefined, referral?: IgIncoming["referral"]): { text: string; source?: ConversationSource } {
  const at = Date.now();
  const ref = m?.referral ?? referral;
  const story = m?.reply_to?.story;
  const mention = m?.attachments?.find((a) => a.type === "story_mention");
  let text = m?.text ?? "";
  if (story) text = `[Ответ на вашу историю${story.url ? ` ${story.url}` : ""}] ${text}`.trim();
  if (mention) text = `[Клиент упомянул вас в своей истории${mention.payload?.url ? ` ${mention.payload.url}` : ""}] ${text}`.trim();
  if (!text && m?.attachments?.length) text = "[вложение]";
  const source: ConversationSource | undefined =
    ref && (ref.source === "ADS" || ref.ad_id)
      ? { kind: "ad", title: ref.ads_context_data?.ad_title, ref: ref.ad_id ?? ref.ref, at }
      : ref?.ref
        ? { kind: "link", ref: ref.ref, at }
        : story || mention
          ? { kind: "story", url: story?.url ?? mention?.payload?.url, at }
          : undefined;
  return { text, source };
}

const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Кодовое слово в комментарии (целым словом, без учёта регистра); postId — только под этим постом. */
export function matchTrigger(triggers: IgTrigger[] | undefined, text: string, mediaId?: string) {
  const w = words(text);
  return (triggers ?? []).find((t) => t.keyword.trim() && t.dm.trim() && (!t.postId || t.postId === mediaId) && w.includes(words(t.keyword)));
}

/** «Напишите ПРАЙС»: личное сообщение автору комментария, короткий публичный ответ, разговор в директе с источником. */
async function runTrigger(channel: Channel, t: IgTrigger, ev: { id: string; text: string; fromId?: string; username?: string; postUrl?: string }) {
  const cfg = channel.config as InstagramConfig;
  const ig = await import("./instagram");
  const sent = await ig.sendPrivateReply(cfg.token, ev.id, t.dm.trim());
  if (t.reply.trim()) await ig.replyToComment(cfg.token, ev.id, t.reply.trim()).catch((e) => console.error("trigger public reply failed", e instanceof Error ? e.message : e));
  const sender = sent.recipient_id ?? ev.fromId;
  if (!sender) return;
  const { conversation } = await upsertConversation(channel, `dm:${sender}`, { handle: ev.username ? `@${ev.username}` : "" });
  await setSource(conversation, { kind: "comment", title: t.keyword.trim(), url: ev.postUrl, at: Date.now() });
  await addMessage(conversation.id, "system", `Комментарий с кодовым словом «${t.keyword.trim()}»: ${ev.text.slice(0, 500)}`, { externalId: ev.id });
  await addMessage(conversation.id, "assistant", t.dm.trim(), { externalId: sent.message_id });
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
  if ((ev.fromId && ev.fromId === cfg.igUserId) || (ev.username && ev.username === cfg.username)) return;
  if (await seen(channel.id, ev.id)) return;
  // Кодовое слово — личное сообщение автору вместо обычного ответа в комментариях
  const trigger = !ev.parentId ? matchTrigger(cfg.triggers, ev.text, ev.mediaId) : undefined;
  if (trigger) {
    try {
      return await runTrigger(channel, trigger, ev);
    } catch (e) {
      console.error("instagram trigger failed", e instanceof Error ? e.message : e);
    }
  }
  if (!cfg.comments) return;

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
