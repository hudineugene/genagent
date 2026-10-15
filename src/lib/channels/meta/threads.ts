import "server-only";
import { metaFetch } from "./http";

/** Threads API v1.0. Личных сообщений в API нет — агент отвечает на ответы под постами аккаунта. */
const GRAPH = () => process.env.THREADS_GRAPH_URL ?? "https://graph.threads.net";
const AUTHORIZE = () => process.env.THREADS_AUTHORIZE_URL ?? "https://threads.com/oauth/authorize";
const V = "v1.0";

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_read_replies", "threads_manage_replies"];

export function authorizeUrl(appId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: THREADS_SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE()}?${q}`;
}

export async function exchangeCode(appId: string, appSecret: string, redirectUri: string, code: string) {
  const short = await metaFetch<{ access_token: string; user_id: string | number }>(`${GRAPH()}/oauth/access_token`, {
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
      grant_type: "th_exchange_token",
      client_secret: appSecret,
      access_token: short.access_token,
    })}`,
  );
  const me = await getMe(long.access_token);
  return { token: long.access_token, expiresAt: Date.now() + long.expires_in * 1000, ...me };
}

export async function refreshToken(token: string) {
  const r = await metaFetch<{ access_token: string; expires_in: number }>(
    `${GRAPH()}/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: token })}`,
  );
  return { token: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
}

export async function getMe(token: string) {
  const me = await metaFetch<{ id: string; username: string }>(`${GRAPH()}/${V}/me?fields=id,username`, { token });
  return { threadsUserId: String(me.id), username: me.username };
}

export type ThreadsPost = { id: string; text?: string; permalink?: string; timestamp: string };
export type ThreadsReply = {
  id: string;
  text?: string;
  username?: string;
  timestamp: string;
  permalink?: string;
  replied_to?: { id: string };
  root_post?: { id: string };
  is_reply_owned_by_me?: boolean;
  hide_status?: string;
};

export async function myPosts(token: string, limit = 10) {
  const r = await metaFetch<{ data: ThreadsPost[] }>(
    `${GRAPH()}/${V}/me/threads?fields=id,text,permalink,timestamp&limit=${limit}`,
    { token },
  );
  return r.data ?? [];
}

/** Все ответы под постом на любой глубине (плоский список). */
export async function conversation(token: string, postId: string) {
  const r = await metaFetch<{ data: ThreadsReply[] }>(
    `${GRAPH()}/${V}/${postId}/conversation?fields=id,text,username,timestamp,permalink,replied_to,root_post,is_reply_owned_by_me,hide_status&reverse=false`,
    { token },
  );
  return r.data ?? [];
}

/** Ответ на пост/ответ: контейнер → публикация (для текста обычно сразу, иначе повтор через паузу). */
export async function publishReply(token: string, replyToId: string, text: string) {
  const container = await metaFetch<{ id: string }>(`${GRAPH()}/${V}/me/threads`, {
    method: "POST",
    token,
    body: new URLSearchParams({ media_type: "TEXT", text: text.slice(0, 500), reply_to_id: replyToId }),
  });
  let lastError: unknown;
  for (const wait of [0, 3000, 10000, 30000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await metaFetch<{ id: string }>(`${GRAPH()}/${V}/me/threads_publish`, {
        method: "POST",
        token,
        body: new URLSearchParams({ creation_id: container.id }),
      });
      return r.id;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
