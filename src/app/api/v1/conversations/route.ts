import { and, desc, eq, gte, inArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { authorize, fail, iso } from "@/lib/public-api";

/**
 * GET /api/v1/conversations?client_id=&agent_id=&updated_since=ISO&status=open|closed&limit=50 —
 * разговоры (новые сверху), с карточкой лида и источником; тестовые — нет.
 */
export async function GET(req: Request) {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const sp = new URL(req.url).searchParams;
  const clientId = sp.get("client_id");
  if (clientId && !auth.can(clientId)) return fail(403, "client_not_allowed");
  const since = sp.get("updated_since");
  const sinceDate = since ? new Date(since) : null;
  if (sinceDate && Number.isNaN(sinceDate.getTime())) return fail(400, "bad_updated_since");
  const limit = Math.min(200, Math.max(1, Number(sp.get("limit")) || 50));
  const where: SQL[] = [eq(conversations.isTest, false)];
  if (clientId) where.push(eq(conversations.clientId, clientId));
  else if (auth.key.clientIds) where.push(inArray(conversations.clientId, auth.key.clientIds.length ? auth.key.clientIds : ["-"]));
  if (sp.get("agent_id")) where.push(eq(conversations.agentId, sp.get("agent_id")!));
  if (sinceDate) where.push(gte(conversations.lastMessageAt, sinceDate));
  const status = sp.get("status");
  if (status === "open" || status === "closed") where.push(eq(conversations.status, status));
  const rows = await db.select().from(conversations).where(and(...where)).orderBy(desc(conversations.lastMessageAt)).limit(limit);
  return Response.json({
    data: rows.map((c) => ({
      id: c.id,
      client_id: c.clientId,
      agent_id: c.agentId,
      channel: c.channelType,
      contact: { name: c.contactName, handle: c.contactHandle },
      status: c.status,
      mode: c.mode,
      needs_attention: c.needsAttention,
      last_message: c.lastMessageText,
      last_message_at: iso(c.lastMessageAt),
      lead: c.context?.lead ? { temperature: c.context.lead.temperature, fields: Object.fromEntries(c.context.lead.fields.map((f) => [f.label, f.value])) } : null,
      source: c.context?.source ?? null,
      created_at: iso(c.createdAt),
    })),
  });
}
