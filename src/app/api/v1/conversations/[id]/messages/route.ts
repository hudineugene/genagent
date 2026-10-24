import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { operatorReplyCore } from "@/lib/operator";
import { authorize, fail } from "@/lib/public-api";

/** POST /api/v1/conversations/{id}/messages { text } — написать клиенту от имени сотрудника (ключ с правом write). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize(req, "write");
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const [c] = await db.select({ clientId: conversations.clientId }).from(conversations).where(eq(conversations.id, id));
  if (!c || !auth.can(c.clientId)) return fail(404, "not_found");
  const body = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return fail(400, "text_required");
  const r = await operatorReplyCore(id, body.data.text);
  if (r.error) return fail(422, r.error);
  return Response.json({ ok: true }, { status: 201 });
}
