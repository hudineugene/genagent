import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { monitors } from "@/db/schema";
import { signal } from "@/lib/monitor";

/**
 * Сигнал о сбое из системы клиента (лог ошибок, метрики): POST с заголовком Authorization: Bearer <ключ>.
 * Тело: { "status": "down" | "up", "message": "..." } или { "errors": 37, "threshold": 10 }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ monitorId: string }> }) {
  const { monitorId } = await params;
  const [m] = await db.select().from(monitors).where(eq(monitors.id, monitorId));
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok = m && key.length === m.apiKey.length && timingSafeEqual(Buffer.from(key), Buffer.from(m.apiKey));
  if (!ok) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!m.enabled) return Response.json({ error: "disabled" }, { status: 409 });
  const body = (await req.json().catch(() => null)) as { status?: string; message?: string; errors?: number; threshold?: number } | null;
  if (!body || (typeof body.status !== "string" && typeof body.errors !== "number")) return Response.json({ error: "invalid", hint: 'Send {"status":"down","message":"..."} or {"errors":N,"threshold":M}' }, { status: 400 });
  const r = await signal(m, { status: body.status, message: typeof body.message === "string" ? body.message : undefined, errors: body.errors, threshold: typeof body.threshold === "number" ? body.threshold : undefined });
  const [after] = await db.select({ status: monitors.status }).from(monitors).where(eq(monitors.id, m.id));
  return Response.json({ ok: true, status: after?.status, incident: Boolean(r.incident) });
}
