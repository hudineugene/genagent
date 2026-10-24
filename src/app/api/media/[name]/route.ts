import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { jsonText } from "@/db/dialect";
import { conversations, messages } from "@/db/schema";
import { canClient, scopeOf } from "@/lib/access";
import { findCurrentUser } from "@/lib/auth";
import { MEDIA_DIR, MEDIA_NAME } from "@/lib/media";

/** Превью фото из переписки (lib/media) — только для вошедших в студию и только по доступным им клиентам. */
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = await findCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const { name } = await params;
  if (!MEDIA_NAME.test(name)) return new Response("not found", { status: 404 });
  // Сотрудник с доступом к части клиентов и владелец бизнеса — только фото из разговоров своих клиентов
  if (user.role === "client" || scopeOf(user)) {
    const [row] = await db
      .select({ clientId: conversations.clientId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(sql`${jsonText(messages.meta, "thumb")} = ${name}`)
      .limit(1);
    if (user.role === "client" || !row || !canClient(user, row.clientId)) return new Response("not found", { status: 404 });
  }
  try {
    const data = await fs.readFile(path.join(MEDIA_DIR, name));
    return new Response(new Uint8Array(data), {
      headers: { "content-type": TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "private, max-age=86400" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
