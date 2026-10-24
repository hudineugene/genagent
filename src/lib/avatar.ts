import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR } from "@/lib/media";
import { imageType } from "@/lib/client-logo";

/** Фото сотрудников (профиль): media/avatars/<id>, PNG/JPEG/WEBP до 1 МБ — тип по первым байтам, SVG не принимаем. */
const DIR = path.join(MEDIA_DIR, "avatars");
export const MAX_AVATAR_BYTES = 1_000_000;
const file = (userId: string) => path.join(DIR, userId.replace(/[^0-9a-f-]/gi, ""));

export async function readAvatar(userId: string): Promise<{ type: string; data: Buffer } | null> {
  try {
    const data = await fs.readFile(file(userId));
    const type = imageType(data);
    return type ? { type, data } : null;
  } catch {
    return null;
  }
}

export async function saveAvatar(userId: string, data: Buffer) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(file(userId), data);
}

export async function removeAvatar(userId: string) {
  await fs.rm(file(userId), { force: true });
}

/** Версии фото (время загрузки) — в адрес картинки, чтобы замена была видна сразу; 0 — фото нет. */
export async function avatarVersions(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    for (const f of await fs.readdir(DIR)) out.set(f, Math.floor((await fs.stat(path.join(DIR, f))).mtimeMs));
  } catch {}
  return out;
}
