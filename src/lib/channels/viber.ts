import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Viber Bot API: бот компании (токен из партнёрского кабинета Viber). Сообщения клиентов приходят на наш вебхук
 * (подпись — HMAC-SHA256 токеном), ответы — send_message от имени бота. Кнопки — клавиатура Viber.
 */
const base = () => (process.env.VIBER_URL ?? "https://chatapi.viber.com").replace(/\/$/, "");

export class ViberError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(token: string, method: string, body: object): Promise<T> {
  const res = await fetch(`${base()}/pa/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Viber-Auth-Token": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({ status: -1, status_message: `HTTP ${res.status}` }))) as { status: number; status_message?: string } & T;
  if (j.status !== 0) throw new ViberError(j.status, j.status_message ?? "viber_error");
  return j;
}

export function getAccountInfo(token: string) {
  return call<{ name: string; uri?: string; icon?: string }>(token, "get_account_info", {});
}

/** Зарегистрировать вебхук (Viber сразу присылает на него событие «webhook» — адрес должен отвечать 200). Пустой адрес — снять. */
export function setWebhook(token: string, url: string) {
  return call(token, "set_webhook", url ? { url, event_types: ["conversation_started", "unsubscribed", "failed"], send_name: true } : { url: "" });
}

export type ViberButton = { text: string; reply?: string; url?: string };

/** Кнопки под сообщением (клавиатура Viber): ответ текстом или ссылка. */
export function keyboard(buttons: ViberButton[]) {
  const cols = buttons.length <= 2 ? 3 : 6;
  return {
    Type: "keyboard",
    DefaultHeight: false,
    Buttons: buttons.slice(0, 12).map((b) => ({
      Columns: cols,
      Rows: 1,
      Text: b.text.slice(0, 120),
      ActionType: b.url ? "open-url" : "reply",
      ActionBody: (b.url ?? b.reply ?? b.text).slice(0, 2000),
      TextSize: "regular",
    })),
  };
}

export async function sendText(token: string, receiver: string, text: string, sender: { name: string; avatar?: string }, buttons?: ViberButton[]) {
  const r = await call<{ message_token?: number }>(token, "send_message", {
    receiver,
    min_api_version: buttons?.length ? 3 : 1,
    sender: { name: sender.name.slice(0, 28), ...(sender.avatar ? { avatar: sender.avatar } : {}) },
    type: "text",
    text: text.slice(0, 7000),
    ...(buttons?.length ? { keyboard: keyboard(buttons) } : {}),
  });
  return r.message_token ? String(r.message_token) : null;
}

export function validSignature(raw: string, signature: string | null, token: string) {
  if (!signature) return false;
  const want = createHmac("sha256", token).update(raw).digest("hex");
  return want.length === signature.length && timingSafeEqual(Buffer.from(want), Buffer.from(signature));
}

export type ViberEvent = {
  event: string;
  message_token?: number;
  user?: { id: string; name?: string; language?: string };
  sender?: { id: string; name?: string; language?: string };
  message?: { type: string; text?: string; media?: string; file_name?: string; contact?: { name?: string; phone_number?: string }; location?: { lat: number; lon: number } };
};

/** Текст сообщения клиента; не текст (фото, файл, контакт, место) — короткая пометка. */
export function messageText(m: NonNullable<ViberEvent["message"]>) {
  if (m.type === "text") return m.text ?? "";
  if (m.type === "contact" && m.contact) return `[Клиент поделился контактом: ${m.contact.name ?? ""} ${m.contact.phone_number ?? ""}]`.trim();
  if (m.type === "location" && m.location) return `[Клиент прислал геопозицию: ${m.location.lat}, ${m.location.lon}]`;
  if (m.type === "picture") return m.text ? m.text : "[Клиент прислал фото]";
  if (m.type === "file") return `[Клиент прислал файл ${m.file_name ?? ""}]`.trim();
  if (m.type === "sticker") return "👍";
  return "";
}
