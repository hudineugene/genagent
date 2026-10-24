import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels } from "@/db/schema";
import { authorize, fail, iso } from "@/lib/public-api";

/** GET /api/v1/agents?client_id=… — агенты (без инструкций и ключей) и их каналы. */
export async function GET(req: Request) {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const clientId = new URL(req.url).searchParams.get("client_id");
  if (clientId && !auth.can(clientId)) return fail(403, "client_not_allowed");
  const [rows, chans] = await Promise.all([
    db.select({ id: agents.id, clientId: agents.clientId, name: agents.name, status: agents.status, config: agents.config, createdAt: agents.createdAt }).from(agents).where(clientId ? eq(agents.clientId, clientId) : undefined).orderBy(asc(agents.createdAt)),
    db.select({ id: channels.id, agentId: channels.agentId, type: channels.type, name: channels.name, enabled: channels.enabled }).from(channels),
  ]);
  return Response.json({
    data: rows
      .filter((a) => auth.can(a.clientId))
      .map((a) => ({
        id: a.id,
        client_id: a.clientId,
        name: a.name,
        status: a.status,
        model: a.config.model,
        channels: chans.filter((c) => c.agentId === a.id).map((c) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled })),
        created_at: iso(a.createdAt),
      })),
  });
}
