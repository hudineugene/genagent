import "server-only";
import { metaFetch } from "./http";

/**
 * Facebook Messenger (страница компании): токен страницы из Meta Business, вебхук приложения Meta (object = page).
 * Входящие — как директ Instagram (messaging[]), ответы — Send API от имени страницы.
 */
const GRAPH = () => process.env.MESSENGER_GRAPH_URL ?? "https://graph.facebook.com";
const V = "v25.0";

export async function getPage(token: string) {
  return metaFetch<{ id: string; name: string }>(`${GRAPH()}/${V}/me?fields=id,name`, { token });
}

/** Подписать страницу на вебхуки приложения: сообщения, кнопки, переходы из рекламы и ссылок m.me?ref=. */
export function subscribePage(token: string, pageId: string) {
  return metaFetch<{ success: boolean }>(`${GRAPH()}/${V}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_referrals`, { method: "POST", token });
}

/** Ответ клиенту (до 2000 знаков на сообщение, длинное — частями). Возвращает id последнего. */
export async function sendMessenger(token: string, recipientId: string, text: string, buttons?: string[]) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 1900) {
    const cut = rest.lastIndexOf("\n", 1900) > 900 ? rest.lastIndexOf("\n", 1900) : 1900;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  let last = "";
  for (const [i, p] of parts.entries()) {
    const quick = i === parts.length - 1 && buttons?.length ? { quick_replies: buttons.slice(0, 13).map((b) => ({ content_type: "text", title: b.slice(0, 20), payload: b.slice(0, 1000) })) } : {};
    const r = await metaFetch<{ message_id: string }>(`${GRAPH()}/${V}/me/messages`, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: p, ...quick } }),
    });
    last = r.message_id;
  }
  return last;
}
