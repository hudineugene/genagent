import "server-only";
import { metaFetch, splitByBytes } from "./http";

/**
 * Instagram API со входом через Instagram (без страницы Facebook), Graph API v25.0.
 * Адреса можно подменить переменными окружения — для тестов с локальным макетом.
 */
const GRAPH = () => process.env.INSTAGRAM_GRAPH_URL ?? "https://graph.instagram.com";
const OAUTH = () => process.env.INSTAGRAM_OAUTH_URL ?? "https://api.instagram.com";
const AUTHORIZE = () => process.env.INSTAGRAM_AUTHORIZE_URL ?? "https://www.instagram.com/oauth/authorize";
const V = "v25.0";

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
];

export function authorizeUrl(appId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE()}?${q}`;
}

/** Код → короткий токен → долгоживущий (60 дней) + данные аккаунта. */
export async function exchangeCode(appId: string, appSecret: string, redirectUri: string, code: string) {
  const short = await metaFetch<{ access_token: string; user_id: string | number }>(`${OAUTH()}/oauth/access_token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: code.replace(/#_$/, ""),
    }),
  });
  const long = await metaFetch<{ access_token: string; expires_in: number }>(
    `${GRAPH()}/access_token?${new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: appSecret,
      access_token: short.access_token,
    })}`,
  );
  const me = await getMe(long.access_token);
  return { token: long.access_token, expiresAt: Date.now() + long.expires_in * 1000, ...me };
}

export async function refreshToken(token: string) {
  const r = await metaFetch<{ access_token: string; expires_in: number }>(
    `${GRAPH()}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`,
  );
  return { token: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
}

export async function getMe(token: string) {
  const me = await metaFetch<{ user_id: string; username: string }>(`${GRAPH()}/${V}/me?fields=user_id,username`, { token });
  return { igUserId: String(me.user_id), username: me.username };
}

/** Подписать аккаунт на вебхуки директа и комментариев. */
export function subscribeWebhooks(token: string) {
  return metaFetch<{ success: boolean }>(
    `${GRAPH()}/${V}/me/subscribed_apps?subscribed_fields=messages,comments`,
    { method: "POST", token },
  );
}

/** Ответ в директ (лимит Instagram — 1000 байт на сообщение, длинное делим). Возвращает id последнего. */
export async function sendDm(token: string, recipientId: string, text: string) {
  let last = "";
  for (const part of splitByBytes(text, 1000)) {
    const r = await metaFetch<{ message_id: string }>(`${GRAPH()}/${V}/me/messages`, {
      method: "POST",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }),
    });
    last = r.message_id;
  }
  return last;
}

/** Личное сообщение автору комментария (private reply): одно на комментарий, в течение 7 дней после него. */
export async function sendPrivateReply(token: string, commentId: string, text: string) {
  const r = await metaFetch<{ message_id: string; recipient_id?: string }>(`${GRAPH()}/${V}/me/messages`, {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } }),
  });
  return r;
}

/** Публичный ответ на комментарий (только на комментарии верхнего уровня). */
export async function replyToComment(token: string, commentId: string, text: string) {
  const r = await metaFetch<{ id: string }>(`${GRAPH()}/${V}/${commentId}/replies`, {
    method: "POST",
    token,
    body: new URLSearchParams({ message: text.slice(0, 2200) }),
  });
  return r.id;
}

export type IgMedia = { id: string; caption?: string; permalink?: string; timestamp: string };
export type IgComment = {
  id: string;
  text: string;
  timestamp: string;
  username?: string;
  from?: { id: string; username?: string };
  parent_id?: string;
};

export async function recentMedia(token: string, limit = 10) {
  const r = await metaFetch<{ data: IgMedia[] }>(
    `${GRAPH()}/${V}/me/media?fields=id,caption,permalink,timestamp&limit=${limit}`,
    { token },
  );
  return r.data ?? [];
}

export async function mediaComments(token: string, mediaId: string) {
  const r = await metaFetch<{ data: IgComment[] }>(
    `${GRAPH()}/${V}/${mediaId}/comments?fields=id,text,timestamp,username,from,parent_id&limit=50`,
    { token },
  );
  return r.data ?? [];
}

export async function getMedia(token: string, mediaId: string) {
  return metaFetch<IgMedia>(`${GRAPH()}/${V}/${mediaId}?fields=id,caption,permalink,timestamp`, { token });
}
