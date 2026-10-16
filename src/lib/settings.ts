import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

export type AppCredentials = { appId: string; appSecret: string };

/** Ключи приложений Meta: у Instagram и Threads в кабинете Meta свои ID и секреты. */
export type MetaSettings = {
  instagram?: AppCredentials;
  threads?: AppCredentials;
  /** Приложение с продуктом WhatsApp (может совпадать с приложением Instagram) */
  whatsapp?: AppCredentials;
  /** Секрет для подтверждения адреса вебхука в кабинете Meta (Verify Token). */
  verifyToken: string;
};

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown) {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function getMetaSettings(): Promise<MetaSettings> {
  const s = await getSetting<MetaSettings>("meta");
  if (s?.verifyToken) return s;
  const fresh: MetaSettings = { ...s, verifyToken: randomBytes(16).toString("hex") };
  await setSetting("meta", fresh);
  return fresh;
}

/** Публичный адрес программы (для OAuth и вебхуков Meta). На сервере — PUBLIC_URL из secrets.env. */
export function publicUrl(): string | null {
  const u = process.env.PUBLIC_URL?.trim().replace(/\/$/, "");
  return u || null;
}

export function metaUrls(base: string) {
  return {
    instagramRedirect: `${base}/oauth/instagram/callback`,
    threadsRedirect: `${base}/oauth/threads/callback`,
    instagramWebhook: `${base}/api/webhooks/instagram`,
    threadsWebhook: `${base}/api/webhooks/threads`,
    whatsappWebhook: `${base}/api/webhooks/whatsapp`,
    deauthorize: `${base}/api/webhooks/deauthorize`,
    dataDeletion: `${base}/api/webhooks/data-deletion`,
  };
}
