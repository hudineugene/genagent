import { asc } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { authorize, iso } from "@/lib/public-api";

/** GET /api/v1/clients — клиенты студии (доступные ключу). */
export async function GET(req: Request) {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const rows = await db.select().from(clients).orderBy(asc(clients.name));
  return Response.json({
    data: rows.filter((c) => auth.can(c.id)).map((c) => ({ id: c.id, name: c.name, industry: c.industry, website: c.website, created_at: iso(c.createdAt) })),
  });
}
