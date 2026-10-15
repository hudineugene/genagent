import "server-only";

// Адрес API можно подменить (TELEGRAM_API_URL) — для тестов с локальным макетом Telegram.
const API = () => process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Любой метод Bot API (например, для бота уведомлений студии). */
export const callTelegram = <T>(token: string, method: string, body?: unknown, signal?: AbortSignal) => call<T>(token, method, body, signal);

async function call<T>(token: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API()}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const data = (await res.json().catch(() => null)) as
    | { ok: true; result: T }
    | { ok: false; error_code: number; description: string }
    | null;
  if (!data) throw new TelegramError(res.status, `HTTP ${res.status}`);
  if (!data.ok) throw new TelegramError(data.error_code, data.description);
  return data.result;
}

export type TgUser = { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean };
export type TgChat = { id: number; type: string; title?: string; username?: string };
export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  /** Сообщение от имени канала/группы (сам канал, анонимный админ) */
  sender_chat?: TgChat;
  /** Ветка обсуждения поста: id автоматически пересланного поста в группе обсуждений */
  message_thread_id?: number;
  /** Пост канала, автоматически пересланный в группу обсуждений */
  is_automatic_forward?: boolean;
  forward_origin?: { type: string; chat?: TgChat; message_id?: number };
  reply_to_message?: TgMessage;
  text?: string;
  caption?: string;
  photo?: unknown;
  voice?: unknown;
  video?: unknown;
  document?: { file_name?: string };
  sticker?: { emoji?: string };
};
export type TgUpdate = { update_id: number; message?: TgMessage };

export const getMe = (token: string) =>
  call<{ id: number; username: string; first_name: string }>(token, "getMe");

export const deleteWebhook = (token: string) => call<boolean>(token, "deleteWebhook", { drop_pending_updates: false });

export const getUpdates = (token: string, offset: number | undefined, signal?: AbortSignal) =>
  call<TgUpdate[]>(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, signal);

export const sendChatAction = (token: string, chatId: string) =>
  call<boolean>(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => false);

/** Отправляет текст, разбивая на части по 4000 символов (лимит Telegram — 4096). */
export async function sendText(token: string, chatId: string, text: string) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    const cut = rest.lastIndexOf("\n", 4000) > 2000 ? rest.lastIndexOf("\n", 4000) : 4000;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  for (const p of parts) await call(token, "sendMessage", { chat_id: chatId, text: p });
}

/** Ответ в группе на конкретное сообщение (комментарий под постом канала). Возвращает id первой части ответа. */
export async function replyInGroup(token: string, chatId: string, replyTo: string, text: string): Promise<string> {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    const cut = rest.lastIndexOf("\n", 4000) > 2000 ? rest.lastIndexOf("\n", 4000) : 4000;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  let first = "";
  for (const p of parts) {
    const m = await call<{ message_id: number }>(token, "sendMessage", {
      chat_id: chatId,
      text: p,
      reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true },
    });
    first ||= String(m.message_id);
  }
  return first;
}

/** Текстовое описание входящего сообщения, включая вложения. */
export function messageText(m: TgMessage): string {
  if (m.text) return m.text;
  const caption = m.caption ? ` ${m.caption}` : "";
  if (m.photo) return `[фото]${caption}`;
  if (m.voice) return `[голосовое сообщение]${caption}`;
  if (m.video) return `[видео]${caption}`;
  if (m.document) return `[файл ${m.document.file_name ?? ""}]${caption}`;
  if (m.sticker) return m.sticker.emoji ?? "[стикер]";
  return "[сообщение]";
}
