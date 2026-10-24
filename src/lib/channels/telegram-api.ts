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

/** Фото файлом (multipart) с подписью в HTML: публикация поста с картинкой в канал. */
/** Голосовое (OGG/Opus) с подписью-текстом. Возвращает id сообщения. */
export async function sendVoice(token: string, chatId: string, ogg: Buffer, caption?: string): Promise<number | null> {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("voice", new Blob([new Uint8Array(ogg)], { type: "audio/ogg" }), "voice.ogg");
  if (caption) form.set("caption", caption.slice(0, 1024));
  const res = await fetch(`${API()}/bot${token}/sendVoice`, { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as { ok: true; result: { message_id: number } } | { ok: false; error_code: number; description: string } | null;
  if (!data) throw new TelegramError(res.status, `HTTP ${res.status}`);
  if (!data.ok) throw new TelegramError(data.error_code, data.description);
  return data.result.message_id;
}

export async function sendPhoto(token: string, chatId: string, photo: { buf: Buffer; type: string; name: string }, captionHtml?: string) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("photo", new Blob([new Uint8Array(photo.buf)], { type: photo.type }), photo.name);
  if (captionHtml) {
    form.set("caption", captionHtml);
    form.set("parse_mode", "HTML");
  }
  const res = await fetch(`${API()}/bot${token}/sendPhoto`, { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as
    | { ok: true; result: { message_id: number; chat: { username?: string } } }
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
  photo?: { file_id: string; file_size?: number; width?: number }[];
  voice?: { file_id: string; duration?: number; file_size?: number };
  video?: unknown;
  document?: { file_id?: string; file_name?: string; file_size?: number; mime_type?: string };
  sticker?: { emoji?: string };
};
export type TgUpdate = { update_id: number; message?: TgMessage };

/** Скачать файл, который прислал клиент (документ, фото). null — слишком большой или не вышло. */
export async function downloadFile(token: string, fileId: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const f = await call<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: fileId });
    if (!f.file_path || (f.file_size ?? 0) > maxBytes) return null;
    const res = await fetch(`${API()}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? null : buf;
  } catch (e) {
    console.error("telegram download failed", e instanceof Error ? e.message : e);
    return null;
  }
}

export const getMe = (token: string) =>
  call<{ id: number; username: string; first_name: string }>(token, "getMe");

export const deleteWebhook = (token: string) => call<boolean>(token, "deleteWebhook", { drop_pending_updates: false });

export const getUpdates = (token: string, offset: number | undefined, signal?: AbortSignal) =>
  call<TgUpdate[]>(token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, signal);

export const sendChatAction = (token: string, chatId: string) =>
  call<boolean>(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => false);

/** Отправляет текст, разбивая на части по 4000 символов (лимит Telegram — 4096). */
/** Черновик ответа, пока агент пишет (Bot API: живёт ~30 с, итог нужно отправить sendMessage). Пустой текст — «Думает…». */
export async function sendMessageDraft(token: string, chatId: string, draftId: number, text: string) {
  await call(token, "sendMessageDraft", { chat_id: Number(chatId), draft_id: draftId, text: text.slice(0, 4096) });
}

/** Кнопки быстрых ответов: нажатие отправляет текст кнопки как сообщение клиента; после нажатия прячутся. */
export function replyKeyboard(buttons: string[]) {
  return { keyboard: buttons.map((b) => [{ text: b }]), resize_keyboard: true, one_time_keyboard: true };
}

export async function sendText(token: string, chatId: string, text: string, buttons?: string[]) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    const cut = rest.lastIndexOf("\n", 4000) > 2000 ? rest.lastIndexOf("\n", 4000) : 4000;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  for (const [i, p] of parts.entries()) {
    const last = i === parts.length - 1;
    await call(token, "sendMessage", { chat_id: chatId, text: p, ...(last && buttons?.length ? { reply_markup: replyKeyboard(buttons) } : {}) });
  }
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
