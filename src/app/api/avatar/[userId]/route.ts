import { findCurrentUser } from "@/lib/auth";
import { readAvatar } from "@/lib/avatar";

/** Фото сотрудника — только сотрудникам студии. Нет фото — 404 (рядом рисуется буква). */
export async function GET(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const me = await findCurrentUser();
  if (!me || me.role === "client") return new Response("not found", { status: 404 });
  const { userId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return new Response("not found", { status: 404 });
  const img = await readAvatar(userId);
  if (!img) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(img.data), {
    headers: { "content-type": img.type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
}
