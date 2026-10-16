import "server-only";
import { metaFetch } from "./http";

/**
 * WhatsApp Business Cloud API (Meta). Канал подключается номером WhatsApp Business: ID номера (phone_number_id)
 * и постоянный токен системного пользователя. Входящие — вебхуком /api/webhooks/whatsapp (поле messages),
 * ответы — сообщением на номер клиента. Отвечать свободным текстом можно в течение 24 часов после последнего
 * сообщения клиента (правило WhatsApp) — для ответов агента этого достаточно.
 */
// Адрес Graph API (в проверках — заглушка)
const GRAPH = process.env.WHATSAPP_GRAPH_URL || "https://graph.facebook.com/v21.0";

/** Номер: как он выглядит для клиентов и подтверждённое имя — проверка при подключении. */
export async function getPhone(token: string, phoneNumberId: string) {
  return metaFetch<{ id: string; display_phone_number: string; verified_name?: string }>(
    `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`,
    { token },
  );
}

/** Текст клиенту (wa_id — номер без «+»). Возвращает id сообщения WhatsApp. */
export async function sendText(token: string, phoneNumberId: string, to: string, text: string): Promise<string | null> {
  const r = await metaFetch<{ messages?: { id: string }[] }>(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text.slice(0, 4096), preview_url: false } }),
  });
  return r.messages?.[0]?.id ?? null;
}

/** Отметить сообщение клиента прочитанным (две синие галочки) — клиент видит, что его услышали. */
export async function markRead(token: string, phoneNumberId: string, messageId: string) {
  await metaFetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
  }).catch(() => {});
}

export type WaMessage = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  image?: { caption?: string };
  document?: { caption?: string; filename?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
};

/** Текст входящего: обычный текст, нажатая кнопка, подпись к вложению или пометка вложения. */
export function messageText(m: WaMessage): string {
  if (m.text?.body) return m.text.body;
  if (m.button?.text) return m.button.text;
  if (m.interactive?.button_reply?.title) return m.interactive.button_reply.title;
  if (m.interactive?.list_reply?.title) return m.interactive.list_reply.title;
  if (m.image) return m.image.caption ? `[фото] ${m.image.caption}` : "[фото]";
  if (m.document) return `[документ${m.document.filename ? `: ${m.document.filename}` : ""}]${m.document.caption ? ` ${m.document.caption}` : ""}`;
  if (m.location) return `[место: ${[m.location.name, m.location.address].filter(Boolean).join(", ") || `${m.location.latitude}, ${m.location.longitude}`}]`;
  if (m.type === "audio" || m.type === "voice") return "[голосовое]";
  if (m.type === "video") return "[видео]";
  if (m.type === "sticker") return "[стикер]";
  return "";
}
