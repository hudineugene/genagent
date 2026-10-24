import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_DIR } from "@/lib/media";

/** Логотипы клиентов: свой (загружен в настройках клиента) главнее значка сайта; хранятся в media/logos. */
export const LOGO_DIR = path.join(MEDIA_DIR, "logos");
export const MAX_LOGO_BYTES = 1_000_000;

const custom = (clientId: string) => path.join(LOGO_DIR, `${clientId}.custom`);

/** Тип картинки по первым байтам (PNG, JPEG, WEBP); SVG и прочее — нет: SVG может содержать скрипт. */
export function imageType(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function readCustomLogo(clientId: string): Promise<{ type: string; data: Buffer } | null> {
  try {
    const data = await fs.readFile(custom(clientId));
    const type = imageType(data);
    return type ? { type, data } : null;
  } catch {
    return null;
  }
}

/**
 * Версии своих логотипов (время загрузки) — для адреса картинки: браузер держит уже показанную картинку в памяти
 * и без нового адреса не увидит замену в списках.
 */
export async function logoVersions(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    for (const f of await fs.readdir(LOGO_DIR)) {
      if (!f.endsWith(".custom")) continue;
      const st = await fs.stat(path.join(LOGO_DIR, f));
      out.set(f.slice(0, -".custom".length), Math.floor(st.mtimeMs));
    }
  } catch {}
  return out;
}

export async function saveCustomLogo(clientId: string, data: Buffer) {
  await fs.mkdir(LOGO_DIR, { recursive: true });
  await fs.writeFile(custom(clientId), data);
}

export async function removeCustomLogo(clientId: string) {
  await fs.rm(custom(clientId), { force: true });
}
