import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contentItems } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { removeContentImage, saveContentImage } from "@/lib/content/images";

import { canAccess } from "@/lib/access";
/** Своя картинка к посту (JPG, PNG, WebP до 8 МБ) — заменяет прежнюю. Поле формы: file. */
export async function POST(req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const { itemId } = await params;
  if (!(await canAccess("content", itemId))) return new Response("Forbidden", { status: 403 });
  const [item] = await db.select({ image: contentItems.image }).from(contentItems).where(eq(contentItems.id, itemId));
  if (!item) return Response.json({ error: "not_found" }, { status: 404 });
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return Response.json({ error: "no_file" }, { status: 400 });
  try {
    const name = saveContentImage(Buffer.from(await file.arrayBuffer()), file.type);
    if (item.image) removeContentImage(item.image);
    await db.update(contentItems).set({ image: name, updatedAt: new Date() }).where(eq(contentItems.id, itemId));
    return Response.json({ image: name });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    return Response.json({ error: m === "too_large" || m === "unsupported" ? m : "failed" }, { status: 400 });
  }
}
