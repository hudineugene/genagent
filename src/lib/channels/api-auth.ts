import "server-only";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, type ApiConfig, type Channel, type VoiceConfig } from "@/db/schema";

/** Голосовой канал по адресу и ключу (голосовая платформа передаёт его как Bearer). */
export async function voiceChannel(channelId: string, authorization: string | null): Promise<Channel | null> {
  if (!/^[0-9a-f-]{36}$/.test(channelId)) return null;
  const [channel] = await db.select().from(channels).where(and(eq(channels.id, channelId), eq(channels.type, "voice")));
  if (!channel) return null;
  const given = Buffer.from(authorization?.replace(/^Bearer\s+/i, "").trim() ?? "");
  const expected = Buffer.from((channel.config as VoiceConfig).key);
  return given.length === expected.length && timingSafeEqual(given, expected) ? channel : null;
}

/** Канал «Свой бот» по адресу и ключу из заголовка Authorization: Bearer …; null — нет такого или ключ неверный. */
export async function apiChannel(channelId: string, authorization: string | null): Promise<Channel | null> {
  if (!/^[0-9a-f-]{36}$/.test(channelId)) return null;
  const [channel] = await db.select().from(channels).where(and(eq(channels.id, channelId), eq(channels.type, "api")));
  if (!channel) return null;
  const given = Buffer.from(authorization?.replace(/^Bearer\s+/i, "").trim() ?? "");
  const expected = Buffer.from((channel.config as ApiConfig).key);
  return given.length === expected.length && timingSafeEqual(given, expected) ? channel : null;
}
