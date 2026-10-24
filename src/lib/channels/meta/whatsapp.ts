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

/** Утверждённые шаблоны бизнес-аккаунта: имя, язык, категория, текст и число переменных. */
export async function listTemplates(token: string, wabaId: string) {
  const r = await metaFetch<{ data?: { name: string; language: string; status: string; category: string; components?: { type: string; text?: string }[] }[] }>(
    `${GRAPH}/${wabaId}/message_templates?fields=name,language,status,category,components&limit=200`,
    { token },
  );
  return (r.data ?? [])
    .filter((t) => t.status === "APPROVED")
    .map((t) => {
      const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
      const params = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
      return { name: t.name, language: t.language, category: t.category, body: body.slice(0, 1024), params };
    });
}

/** Шаблон клиенту (вне 24-часового окна): переменные тела {{1}}, {{2}}… по порядку. */
export async function sendTemplate(token: string, phoneNumberId: string, to: string, name: string, language: string, params: string[]): Promise<string | null> {
  const r = await metaFetch<{ messages?: { id: string }[] }>(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: { name, language: { code: language }, ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: text.slice(0, 1000) })) }] } : {}) },
    }),
  });
  return r.messages?.[0]?.id ?? null;
}

/** Скачать медиа клиента (голосовое, фото): сначала адрес по id, затем сам файл с тем же токеном. */
export async function downloadMedia(token: string, mediaId: string, maxBytes: number): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    const info = await metaFetch<{ url?: string; mime_type?: string; file_size?: number }>(`${GRAPH}/${mediaId}`, { token });
    if (!info.url || (info.file_size ?? 0) > maxBytes) return null;
    const res = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= maxBytes ? { buf, mime: info.mime_type ?? "" } : null;
  } catch (e) {
    console.error("whatsapp media download failed", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Голосовое клиенту: загрузить OGG/Opus и отправить как аудио. Возвращает id сообщения. */
export async function sendAudio(token: string, phoneNumberId: string, to: string, ogg: Buffer): Promise<string | null> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", "audio/ogg");
  form.set("file", new Blob([new Uint8Array(ogg)], { type: "audio/ogg" }), "voice.ogg");
  const up = await metaFetch<{ id?: string }>(`${GRAPH}/${phoneNumberId}/media`, { method: "POST", token, body: form });
  if (!up.id) return null;
  const r = await metaFetch<{ messages?: { id: string }[] }>(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "audio", audio: { id: up.id } }),
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
  image?: { id?: string; caption?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  document?: { caption?: string; filename?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** Клиент нажал рекламу «Написать в WhatsApp» (Click-to-WhatsApp) */
  referral?: { source_url?: string; source_id?: string; source_type?: string; headline?: string; body?: string };
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
