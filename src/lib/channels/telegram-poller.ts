import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, type Channel, type ConversationContext, type TelegramConfig } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { addMessage, deliver, scheduleReply, upsertConversation } from "@/lib/conversations";
import { TelegramError, deleteWebhook, downloadFile, getUpdates, messageText, type TgMessage, type TgUpdate } from "./telegram-api";

/**
 * Получение сообщений Telegram через long polling: программе не нужен публичный адрес,
 * бот отвечает, пока программа запущена. Один опросчик на канал.
 */
const g = globalThis as unknown as { __tgPollers?: Map<string, AbortController> };
const pollers = (g.__tgPollers ??= new Map());

export function stopPoller(channelId: string) {
  pollers.get(channelId)?.abort();
  pollers.delete(channelId);
}

export function isPolling(channelId: string) {
  return pollers.has(channelId);
}

export async function startAllPollers() {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.type, "telegram"), eq(channels.enabled, true)));
  for (const r of rows) startPoller(r.id);
}

export function startPoller(channelId: string) {
  stopPoller(channelId);
  const ctrl = new AbortController();
  pollers.set(channelId, ctrl);
  void loop(channelId, ctrl.signal);
}

async function loop(channelId: string, signal: AbortSignal) {
  let backoff = 1000;
  let webhookCleared = false;
  while (!signal.aborted) {
    const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
    if (!ch || !ch.enabled || ch.type !== "telegram") break;
    const cfg = ch.config as TelegramConfig;
    try {
      if (!webhookCleared) {
        await deleteWebhook(cfg.token);
        webhookCleared = true;
      }
      const updates = await getUpdates(cfg.token, cfg.offset, signal);
      if (ch.error) await db.update(channels).set({ error: null }).where(eq(channels.id, channelId));
      backoff = 1000;
      for (const u of updates) {
        await handleUpdate(ch.id, u).catch((e) => console.error("telegram update failed", e));
        cfg.offset = u.update_id + 1;
        // Настройки могли поменять, пока шёл опрос, — сохраняем только позицию, остальное берём свежим.
        const [fresh] = await db.select({ config: channels.config }).from(channels).where(eq(channels.id, channelId));
        await db
          .update(channels)
          .set({ config: { ...((fresh?.config as TelegramConfig) ?? cfg), offset: cfg.offset } })
          .where(eq(channels.id, channelId));
      }
    } catch (e) {
      if (signal.aborted) break;
      // 401 — токен отозван; 409 — этим ботом уже опрашивает другая копия программы.
      const code = e instanceof TelegramError ? e.code : 0;
      const message = code === 401 ? "token_invalid" : code === 409 ? "conflict" : e instanceof Error ? e.message : String(e);
      // 409: бот уже работает в другой программе — сразу выключаем канал, иначе будем отбирать у неё сообщения.
      await db.update(channels).set(code === 409 ? { error: message, enabled: false } : { error: message }).where(eq(channels.id, channelId));
      if (code === 401 || code === 409) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
  if (pollers.get(channelId)?.signal === signal) pollers.delete(channelId);
}

async function handleUpdate(channelId: string, u: TgUpdate) {
  const m = u.message;
  if (!m) return;
  if (m.chat.type === "group" || m.chat.type === "supergroup") return handleGroupMessage(channelId, m);
  if (m.chat.type !== "private") return;

  const [row] = await db
    .select({ channel: channels, agent: agents })
    .from(channels)
    .innerJoin(agents, eq(agents.id, channels.agentId))
    .where(eq(channels.id, channelId));
  if (!row) return;
  const { channel, agent } = row;

  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
  const { conversation } = await upsertConversation(channel, String(m.chat.id), {
    name,
    handle: m.from?.username ? `@${m.from.username}` : "",
  });

  const text = messageText(m);
  const msg = await addMessage(conversation.id, "user", text);
  // Файл или фото: агент читает документ / получает описание фото (до ответа)
  await readAttachment(channel, agent, conversation.id, msg.id, m).catch((e) => console.error("telegram attachment failed", e));

  // Команда запуска бота: отвечаем приветствием агента, если оно задано.
  const greeting = agentConfigSchema.safeParse(agent.config).data?.greeting?.trim();
  if (text.trim() === "/start" && greeting && agent.status === "active" && conversation.mode === "ai") {
    await addMessage(conversation.id, "assistant", greeting);
    await deliver(channel, conversation, greeting);
    return;
  }
  scheduleReply(conversation.id);
}

/** Документ (PDF, Word, текст) — текст в сообщение; фото — описание с надписями и превью. */
async function readAttachment(channel: Channel, agent: { id: string; clientId: string }, conversationId: string, messageId: string, m: TgMessage) {
  const token = (channel.config as TelegramConfig).token;
  if (m.document?.file_id) {
    const name = m.document.file_name ?? "файл";
    const { MAX_DOC_BYTES, attachDocument, readDocument } = await import("@/lib/documents/intake");
    const buf = await downloadFile(token, m.document.file_id, MAX_DOC_BYTES);
    const text = buf ? await readDocument(buf, name) : null;
    if (text) await attachDocument(messageId, { name, text }, { clientId: agent.clientId, agentId: agent.id, conversationId });
    return;
  }
  if (m.photo?.length) {
    // Самый крупный вариант не больше 4 МБ
    const photo = [...m.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0)).find((p) => (p.file_size ?? 0) <= 4 * 1024 * 1024);
    if (!photo) return;
    const buf = await downloadFile(token, photo.file_id, 4 * 1024 * 1024);
    if (!buf) return;
    const { describePhoto, saveThumb } = await import("@/lib/media");
    const data = buf.toString("base64");
    const vision = await describePhoto(data, "image/jpeg", { agentId: agent.id, clientId: agent.clientId }, m.caption);
    const thumb = data.length <= 560_000 ? saveThumb(messageId, data, "image/jpeg") : null;
    const [cur] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
    await db
      .update(messages)
      .set({ meta: { ...cur?.meta, kind: "photo", ...(vision ? { vision } : {}), ...(thumb ? { thumb } : {}) } })
      .where(eq(messages.id, messageId));
    // Фото документа — тоже на разбор по типам документов клиента
    if (vision) {
      const { analyzeDocument } = await import("@/lib/documents/intake");
      void analyzeDocument({ clientId: agent.clientId, agentId: agent.id, conversationId, messageId, filename: "фото", text: vision }).catch(() => null);
    }
  }
}

/**
 * Комментарии под постами канала. Telegram пересылает каждый пост в привязанную группу обсуждений,
 * комментарии — это ответы на него в группе. Бот (администратор группы) отвечает:
 * на комментарии к посту и на ответы людей на его собственные сообщения. Переписку людей между собой не трогает.
 * Один диалог — один человек под одним постом.
 */
async function handleGroupMessage(channelId: string, m: TgMessage) {
  const [row] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!row) return;
  const cfg = row.config as TelegramConfig;
  if (!cfg.comments || m.is_automatic_forward) return;
  // Сообщения от имени канала, анонимных админов и других ботов — не клиенты.
  if (m.sender_chat || !m.from || m.from.is_bot || !m.message_thread_id) return;
  const parent = m.reply_to_message;
  if (!parent) return;
  const toPost = Boolean(parent.is_automatic_forward);
  const toBot = parent.from?.username === cfg.username;
  if (!toPost && !toBot) return;

  const chatId = String(m.chat.id);
  const thread = m.message_thread_id;
  const externalId = `g:${chatId}:${thread}:${m.from.id}`;
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ");
  const { conversation, created } = await upsertConversation(row, externalId, {
    name,
    handle: m.from.username ? `@${m.from.username}` : "",
  });

  const post = toPost ? parent : undefined;
  const channelName = post?.forward_origin?.chat?.username ?? post?.sender_chat?.username ?? cfg.group?.channel;
  const postNo = post?.forward_origin?.message_id;
  const context: ConversationContext = {
    ...(created ? {} : conversation.context),
    chatId,
    replyToId: String(m.message_id),
    ...(post
      ? {
          postId: String(thread),
          postText: messageText(post).slice(0, 500),
          postUrl: channelName && postNo ? `https://t.me/${channelName}/${postNo}` : undefined,
        }
      : {}),
  };
  await db.update(conversations).set({ kind: "comment", context }).where(eq(conversations.id, conversation.id));

  // Запоминаем группу — показать в настройках канала, что комментарии доходят.
  const title = m.chat.title ?? "";
  if (cfg.group?.id !== m.chat.id || cfg.group.title !== title || (channelName && cfg.group.channel !== channelName)) {
    await db
      .update(channels)
      .set({ config: { ...cfg, group: { id: m.chat.id, title, channel: channelName ?? cfg.group?.channel } } })
      .where(eq(channels.id, channelId));
  }

  await addMessage(conversation.id, "user", messageText(m), { externalId: String(m.message_id) });
  scheduleReply(conversation.id);
}
