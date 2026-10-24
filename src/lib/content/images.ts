import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { MEDIA_DIR } from "@/lib/media";

/**
 * Картинки к постам контент-студии: своя (загрузка) или сгенерированная (OpenAI gpt-image-1, ключ из «Внешних
 * сервисов»). Имя неугадываемое: файл открывается без входа по /m/<имя> — так его забирают Threads и соцсети.
 */
export const CONTENT_IMAGE_NAME = /^c_[A-Za-z0-9_-]{20,40}\.(png|jpg|webp)$/;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export function saveContentImage(buf: Buffer, type: string): string {
  const ext = EXT[type];
  if (!ext) throw new Error("unsupported");
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error("too_large");
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const name = `c_${randomBytes(18).toString("base64url")}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return name;
}

export function readContentImage(name: string): { buf: Buffer; type: string } | null {
  if (!CONTENT_IMAGE_NAME.test(name)) return null;
  try {
    return { buf: fs.readFileSync(path.join(MEDIA_DIR, name)), type: IMAGE_TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

export function removeContentImage(name: string) {
  if (!CONTENT_IMAGE_NAME.test(name)) return;
  fs.rm(path.join(MEDIA_DIR, name), { force: true }, () => {});
}

/** Подсказка для генерации по посту: о чём пост, стиль бренда, без текста на картинке. */
export function defaultImagePrompt(p: { title: string; brief: string; client: string; industry: string }) {
  return [
    `Image for a social media post of «${p.client}»${p.industry ? ` (${p.industry})` : ""}.`,
    `Topic: ${p.title || p.brief}`.slice(0, 600),
    "Photorealistic, natural light, clean composition, no text, no letters, no logos, no watermarks.",
  ].join("\n");
}

/** Сгенерировать картинку 1024×1024; около $0.04 за картинку среднего качества. */
export async function generateContentImage(prompt: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no_openai");
  const client = new OpenAI({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL || undefined });
  const r = await client.images.generate({ model: "gpt-image-1", prompt: prompt.slice(0, 4000), size: "1024x1024", quality: "medium", n: 1 });
  const b64 = r.data?.[0]?.b64_json;
  if (!b64) throw new Error("empty");
  return saveContentImage(Buffer.from(b64, "base64"), "image/png");
}
