import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { channels, type Channel, type InstagramConfig, type ThreadsConfig } from "@/db/schema";
import { MetaError } from "./http";
import * as ig from "./instagram";
import * as th from "./threads";
import { handleInstagramComment, handleThreadsReply } from "./inbound";

/**
 * Периодическая проверка новых комментариев Instagram и ответов Threads. Работает и без вебхуков
 * (пока приложение Meta не прошло проверку), а вместе с вебхуками — как подстраховка: повторы отсекаются.
 * Здесь же — продление токенов (живут 60 дней).
 */
const INSTAGRAM_EVERY_MS = 60_000;
const THREADS_EVERY_MS = 120_000;
const REFRESH_BEFORE_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_POST_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const g = globalThis as unknown as { __metaPoller?: ReturnType<typeof setInterval>; __metaLast?: Map<string, number> };
const last = (g.__metaLast ??= new Map());
let running = false;

export function startSocialPolling() {
  if (g.__metaPoller) clearInterval(g.__metaPoller);
  g.__metaPoller = setInterval(() => void tick(), 20_000);
  g.__metaPoller.unref?.();
  void tick();
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const list = await db.select().from(channels).where(inArray(channels.type, ["instagram", "threads"]));
    for (const ch of list) {
      if (!ch.enabled) continue;
      const every = ch.type === "instagram" ? INSTAGRAM_EVERY_MS : THREADS_EVERY_MS;
      if (Date.now() - (last.get(ch.id) ?? 0) < every) continue;
      last.set(ch.id, Date.now());
      try {
        await maybeRefreshToken(ch);
        if (ch.type === "instagram") await pollInstagram(ch);
        else await pollThreads(ch);
        if (ch.error && !["webhook_subscribe_failed"].includes(ch.error)) {
          await db.update(channels).set({ error: null }).where(eq(channels.id, ch.id));
        }
      } catch (e) {
        const code = e instanceof MetaError && (e.code === 190 || e.status === 401) ? "token_invalid" : e instanceof Error ? e.message.slice(0, 200) : String(e);
        console.error("social poll failed", ch.id, e);
        await db.update(channels).set({ error: code }).where(eq(channels.id, ch.id));
        if (ch.error !== code) void import("@/lib/notify/telegram").then((n) => n.notifyProblem(`channel:${ch.id}:${code.slice(0, 40)}`, code, { channelId: ch.id }));
      }
    }
  } finally {
    running = false;
  }
}

async function maybeRefreshToken(ch: Channel) {
  const cfg = ch.config as InstagramConfig | ThreadsConfig;
  if (cfg.tokenExpiresAt - Date.now() > REFRESH_BEFORE_MS) return;
  // Продлевать можно не чаще раза в сутки: проверяем не чаще раза в 6 часов.
  const key = `refresh:${ch.id}`;
  if (Date.now() - (last.get(key) ?? 0) < 6 * 60 * 60 * 1000) return;
  last.set(key, Date.now());
  const r = ch.type === "instagram" ? await ig.refreshToken(cfg.token) : await th.refreshToken(cfg.token);
  await db
    .update(channels)
    .set({ config: { ...cfg, token: r.token, tokenExpiresAt: r.expiresAt } })
    .where(eq(channels.id, ch.id));
}

async function fresh(id: string) {
  const [ch] = await db.select().from(channels).where(eq(channels.id, id));
  return ch;
}

async function pollInstagram(chIn: Channel) {
  const ch = await fresh(chIn.id);
  const cfg = ch.config as InstagramConfig;
  if (!cfg.comments) return;
  const since = cfg.since ?? Math.floor(Date.now() / 1000);
  let newest = since;
  const media = (await ig.recentMedia(cfg.token, 10)).filter((m) => Date.now() - Date.parse(m.timestamp) < MAX_POST_AGE_MS);
  for (const m of media) {
    const comments = (await ig.mediaComments(cfg.token, m.id))
      .filter((c) => Date.parse(c.timestamp) / 1000 > since)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const c of comments) {
      newest = Math.max(newest, Math.floor(Date.parse(c.timestamp) / 1000));
      await handleInstagramComment(ch, {
        id: c.id,
        text: c.text,
        fromId: c.from?.id,
        username: c.username ?? c.from?.username,
        parentId: c.parent_id,
        mediaId: m.id,
        postUrl: m.permalink,
        postText: m.caption,
      });
    }
  }
  if (newest !== cfg.since) await saveSince(ch.id, newest);
}

async function pollThreads(chIn: Channel) {
  const ch = await fresh(chIn.id);
  const cfg = ch.config as ThreadsConfig;
  const since = cfg.since ?? Math.floor(Date.now() / 1000);
  let newest = since;
  const posts = (await th.myPosts(cfg.token, 10)).filter((p) => Date.now() - Date.parse(p.timestamp) < MAX_POST_AGE_MS);
  for (const p of posts) {
    const replies = (await th.conversation(cfg.token, p.id))
      .filter((r) => Date.parse(r.timestamp) / 1000 > since && !r.is_reply_owned_by_me && r.hide_status !== "HIDDEN")
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const r of replies) {
      newest = Math.max(newest, Math.floor(Date.parse(r.timestamp) / 1000));
      await handleThreadsReply(ch, {
        id: r.id,
        text: r.text,
        username: r.username,
        owned: r.is_reply_owned_by_me,
        repliedToId: r.replied_to?.id,
        rootPostId: p.id,
        postUrl: p.permalink,
        postText: p.text,
      });
    }
  }
  if (newest !== cfg.since) await saveSince(ch.id, newest);
}

/** Сохраняем отметку времени, перечитав канал (настройки могли поменяться за время проверки). */
async function saveSince(id: string, since: number) {
  const ch = await fresh(id);
  if (!ch) return;
  await db
    .update(channels)
    .set({ config: { ...(ch.config as InstagramConfig | ThreadsConfig), since } })
    .where(eq(channels.id, id));
}
