import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { DATA_EXTENSIONS, readDataFile } from "@/lib/data/tables";
import { importContacts } from "@/lib/outreach/engine";

import { canAccess } from "@/lib/access";
/** Список контактов из CSV или Excel. Поля формы: clientId, name, file, sheet? (лист Excel). */
export async function POST(req: Request) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  if (!(await canAccess("client", clientId))) return new Response("Forbidden", { status: 403 });
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
  if (!client) return Response.json({ error: "client_not_found" }, { status: 404 });
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "no_file" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return Response.json({ error: "too_large" }, { status: 400 });
  if (!DATA_EXTENSIONS.includes(path.extname(file.name).toLowerCase())) return Response.json({ error: "unsupported" }, { status: 400 });
  try {
    const matrix = readDataFile(Buffer.from(await file.arrayBuffer()), file.name, String(form.get("sheet") ?? "") || undefined).filter((r) => r.some((c) => String(c).trim()));
    const [header, ...rows] = matrix;
    if (!header || !rows.length) return Response.json({ error: "empty" }, { status: 400 });
    const name = String(form.get("name") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
    const r = await importContacts(clientId, name, header.map(String), rows.map((x) => x.map(String)));
    return Response.json({ id: r.list.id, count: r.count });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    return Response.json({ error: m === "empty" ? "no_contacts" : "parse_failed" }, { status: 400 });
  }
}
