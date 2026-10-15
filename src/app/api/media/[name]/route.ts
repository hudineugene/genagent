import fs from "node:fs/promises";
import path from "node:path";
import { findCurrentUser } from "@/lib/auth";
import { MEDIA_DIR, MEDIA_NAME } from "@/lib/media";

/** Превью фото из переписки (lib/media) — только для вошедших в студию. */
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!(await findCurrentUser())) return new Response("unauthorized", { status: 401 });
  const { name } = await params;
  if (!MEDIA_NAME.test(name)) return new Response("not found", { status: 404 });
  try {
    const data = await fs.readFile(path.join(MEDIA_DIR, name));
    return new Response(new Uint8Array(data), {
      headers: { "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "private, max-age=86400" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
