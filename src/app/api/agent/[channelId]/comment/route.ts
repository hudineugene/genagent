import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, messages, type ConversationContext } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";

/**
 * Свой бот присылает комментарий под постом своего канала (из группы обсуждений).
 * Отвечаем сразу { ok } — агент ответит в фоне; готовый (или одобренный менеджером) ответ
 * бот забирает из очереди /outbox и публикует сам, своим именем.
 * Один диалог — один человек под одним постом.
 */
const bodySchema = z.object({
  chatId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^-?\d{1,20}$/)),
  threadId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)),
  messageId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)),
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)),
    name: z.string().max(200).optional(),
    username: z.string().max(100).optional(),
  }),
  text: z.string().trim().min(1).max(4000),
  /** Пост, под которым комментарий (для первого комментария в ветке) */
  post: z.object({ text: z.string().max(4000).optional(), url: z.string().url().max(300).optional() }).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!channel.enabled) return Response.json({ ok: false, reason: "channel_disabled" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { chatId, threadId, messageId, user, text, post } = parsed.data;

  // Повтор того же комментария (бот перезапустился и прислал ещё раз) — не дублируем.
  const { conversation, created } = await upsertConversation(channel, `g:${chatId}:${threadId}:${user.id}`, {
    name: user.name?.trim() || undefined,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  const [dup] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.externalId, messageId)));
  if (dup) return Response.json({ ok: true, conversationId: conversation.id, duplicate: true });

  const context: ConversationContext = {
    ...(created ? {} : conversation.context),
    chatId,
    postId: threadId,
    replyToId: messageId,
    ...(post?.text ? { postText: post.text.slice(0, 500) } : {}),
    ...(post?.url ? { postUrl: post.url } : {}),
  };
  await db.update(conversations).set({ kind: "comment", context }).where(eq(conversations.id, conversation.id));
  await addMessage(conversation.id, "user", text, { externalId: messageId });
  scheduleReply(conversation.id);
  return Response.json({ ok: true, conversationId: conversation.id });
}
