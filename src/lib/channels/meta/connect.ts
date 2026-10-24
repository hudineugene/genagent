import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, oauthStates, type InstagramConfig, type ThreadsConfig } from "@/db/schema";
import { getMetaSettings, metaUrls, publicUrl } from "@/lib/settings";
import * as ig from "./instagram";
import * as th from "./threads";
import { jsonText } from "@/db/dialect";

/** Ссылка входа действует сутки — её можно переслать клиенту, чтобы он вошёл в свой аккаунт сам. */
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;

export type Provider = "instagram" | "threads";

export async function createAuthorizeUrl(provider: Provider, agentId: string, userId: string) {
  const base = publicUrl();
  if (!base) throw new Error("no_public_url");
  const meta = await getMetaSettings();
  const app = meta[provider];
  if (!app) throw new Error("app_not_configured");

  const state = randomBytes(24).toString("base64url");
  await db.insert(oauthStates).values({ state, provider, agentId, userId });
  const urls = metaUrls(base);
  return provider === "instagram"
    ? ig.authorizeUrl(app.appId, urls.instagramRedirect, state)
    : th.authorizeUrl(app.appId, urls.threadsRedirect, state);
}

export type ConnectResult =
  | { ok: true; provider: Provider; username: string; agentName: string; warning?: string }
  | { ok: false; error: string };

/** Возврат после входа: проверяем state, меняем код на токен и создаём (или обновляем) канал агента. */
export async function completeConnect(provider: Provider, state: string, code: string): Promise<ConnectResult> {
  const [st] = await db.select().from(oauthStates).where(eq(oauthStates.state, state));
  if (!st || st.provider !== provider) return { ok: false, error: "state_invalid" };
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (Date.now() - st.createdAt.getTime() > STATE_TTL_MS) return { ok: false, error: "state_expired" };

  const [agent] = await db.select().from(agents).where(eq(agents.id, st.agentId));
  if (!agent) return { ok: false, error: "agent_not_found" };
  const base = publicUrl();
  const app = (await getMetaSettings())[provider];
  if (!base || !app) return { ok: false, error: "app_not_configured" };
  const urls = metaUrls(base);

  const nowSec = Math.floor(Date.now() / 1000);
  let warning: string | undefined;

  if (provider === "instagram") {
    const t = await ig.exchangeCode(app.appId, app.appSecret, urls.instagramRedirect, code);
    const existing = await findByAccount("instagram", "igUserId", t.igUserId);
    if (existing && existing.agentId !== agent.id) return { ok: false, error: "account_used" };
    const config: InstagramConfig = existing
      ? { ...(existing.config as InstagramConfig), token: t.token, tokenExpiresAt: t.expiresAt, username: t.username }
      : { igUserId: t.igUserId, username: t.username, token: t.token, tokenExpiresAt: t.expiresAt, dm: true, comments: true, approval: true, since: nowSec };
    try {
      await ig.subscribeWebhooks(t.token);
    } catch (e) {
      console.error("instagram subscribe failed", e);
      warning = "webhook_subscribe_failed";
    }
    await save(existing?.id, agent, "instagram", `@${t.username}`, config, warning);
    return { ok: true, provider, username: t.username, agentName: agent.name, warning };
  }

  const t = await th.exchangeCode(app.appId, app.appSecret, urls.threadsRedirect, code);
  const existing = await findByAccount("threads", "threadsUserId", t.threadsUserId);
  if (existing && existing.agentId !== agent.id) return { ok: false, error: "account_used" };
  const config: ThreadsConfig = existing
    ? { ...(existing.config as ThreadsConfig), token: t.token, tokenExpiresAt: t.expiresAt, username: t.username }
    : { threadsUserId: t.threadsUserId, username: t.username, token: t.token, tokenExpiresAt: t.expiresAt, approval: true, since: nowSec };
  await save(existing?.id, agent, "threads", `@${t.username}`, config);
  return { ok: true, provider, username: t.username, agentName: agent.name };
}

async function findByAccount(type: Provider, path: string, accountId: string) {
  const [ch] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, type), sql`${jsonText(channels.config, path)} = ${accountId}`));
  return ch;
}

async function save(
  id: string | undefined,
  agent: { id: string; clientId: string },
  type: Provider,
  name: string,
  config: InstagramConfig | ThreadsConfig,
  error?: string,
) {
  if (id) {
    await db.update(channels).set({ name, config, enabled: true, error: error ?? null }).where(eq(channels.id, id));
  } else {
    await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type, name, config, error: error ?? null });
  }
}
