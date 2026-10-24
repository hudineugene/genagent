import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { authorize, fail, iso } from "@/lib/public-api";

/** GET /api/v1/conversations/{id} — разговор с сообщениями (без служебных и черновиков). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!c || !auth.can(c.clientId)) return fail(404, "not_found");
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
  return Response.json({
    id: c.id,
    client_id: c.clientId,
    agent_id: c.agentId,
    channel: c.channelType,
    contact: { name: c.contactName, handle: c.contactHandle },
    status: c.status,
    mode: c.mode,
    lead: c.context?.lead ?? null,
    messages: msgs
      .filter((m) => m.role !== "system" && m.status === "sent")
      .map((m) => ({ id: m.id, role: m.role === "user" ? "customer" : m.role === "assistant" ? "agent" : m.role, text: m.text, at: iso(m.createdAt) })),
  });
}
