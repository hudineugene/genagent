import "server-only";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { getSetting, setSetting } from "@/lib/settings";
import { getNotifySettings } from "@/lib/notify/telegram";

/**
 * Копия базы вне сервера: ежедневная копия сжимается, шифруется паролем (AES-256-GCM, ключ — scrypt)
 * и отправляется ботом уведомлений выбранному сотруднику в Telegram.
 * Хранится производный ключ, а не пароль: расшифровать файл можно только зная пароль (scripts/restore-backup.mjs).
 * Формат файла: "GAB1" | соль 16 | IV 12 | тег 16 | зашифрованный gzip базы.
 */
export type OffsiteSettings = {
  enabled: boolean;
  chatId: string;
  salt: string;
  key: string;
  lastSentAt?: string;
  lastError?: string;
  /** Архив файлов: когда отправлен или почему нет (например, больше 50 МБ — тогда копия только на сервере) */
  filesSentAt?: string;
  filesNote?: string;
};

const KEY = "offsiteBackup";
export const MIN_BACKUP_PASSWORD = 10;
const MAX_TELEGRAM_FILE = 49 * 1024 * 1024;

export async function getOffsiteSettings() {
  return getSetting<OffsiteSettings>(KEY);
}

export async function saveOffsiteSettings(s: OffsiteSettings) {
  await setSetting(KEY, s);
}

/** Ключ из пароля: соль — новая при каждой смене пароля. */
export function deriveKey(password: string) {
  const salt = randomBytes(16);
  return { salt: salt.toString("hex"), key: scryptSync(password, salt, 32).toString("hex") };
}

export function encryptBackup(raw: Buffer, s: Pick<OffsiteSettings, "salt" | "key">) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(s.key, "hex"), iv);
  const body = Buffer.concat([cipher.update(gzipSync(raw)), cipher.final()]);
  return Buffer.concat([Buffer.from("GAB1"), Buffer.from(s.salt, "hex"), iv, cipher.getAuthTag(), body]);
}

/** Отправить копию (файл .db или архив файлов .tar.gz) — после ежедневной копии или по кнопке «Отправить сейчас». */
export async function sendOffsiteBackup(dbFile: string, kind: "db" | "files" = "db"): Promise<{ ok: boolean; error?: string }> {
  const s = await getOffsiteSettings();
  const notify = await getNotifySettings();
  if (!s?.enabled || !s.key || !s.chatId) return { ok: false, error: "not_configured" };
  if (!notify?.token) return { ok: false, error: "no_notify_bot" };
  try {
    const file = encryptBackup(fs.readFileSync(dbFile), s);
    if (file.length > MAX_TELEGRAM_FILE) throw new Error(kind === "files" ? "Архив файлов больше 50 МБ — Telegram его не примет, копия хранится только на сервере" : "Копия больше 50 МБ — Telegram такой файл не примет");
    const name = path.basename(dbFile).replace(/\.(db|tar\.gz)$/, ".gab");
    const form = new FormData();
    form.append("chat_id", s.chatId);
    form.append(
      "caption",
      `🗄 ${kind === "files" ? "Копия файлов (картинки, документы)" : "Копия базы"} GenAgent · ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Kyiv" })}\nЗашифрована паролем копии. Расшифровка: node scripts/restore-backup.mjs ${name}`,
    );
    form.append("document", new Blob([new Uint8Array(file)]), name);
    const api = process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";
    const res = await fetch(`${api}/bot${notify.token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!data?.ok) throw new Error(data?.description ?? `Telegram ответил ${res.status}`);
    if (kind === "files") await saveOffsiteSettings({ ...s, filesSentAt: new Date().toISOString(), filesNote: undefined });
    else await saveOffsiteSettings({ ...s, lastSentAt: new Date().toISOString(), lastError: undefined });
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("offsite backup failed", error);
    if (kind === "files") await saveOffsiteSettings({ ...s, filesNote: error.slice(0, 300) });
    else await saveOffsiteSettings({ ...s, lastError: error.slice(0, 300) });
    return { ok: false, error };
  }
}
