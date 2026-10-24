import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { ARCHIVE_EXTENSIONS, MAX_ARCHIVE_BYTES, archiveFiles } from "@/lib/documents/archive";

import { canAccess } from "@/lib/access";
/**
 * Загрузка документов в архив клиента (несколько файлов): тип, поля, единое имя и папка — сразу.
 * Поля формы: clientId, files (до 20).
 */
export async function POST(req: Request) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  if (!(await canAccess("client", clientId))) return new Response("Forbidden", { status: 403 });
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
  if (!client) return Response.json({ error: "client_not_found" }, { status: 404 });
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return Response.json({ error: "no_files" }, { status: 400 });
  if (files.length > 20) return Response.json({ error: "too_many" }, { status: 400 });
  for (const f of files) {
    if (!ARCHIVE_EXTENSIONS.includes(path.extname(f.name).toLowerCase())) return Response.json({ error: "unsupported", file: f.name }, { status: 400 });
    if (f.size > MAX_ARCHIVE_BYTES) return Response.json({ error: "too_large", file: f.name }, { status: 400 });
  }
  const rows = await archiveFiles(clientId, await Promise.all(files.map(async (f) => ({ buf: Buffer.from(await f.arrayBuffer()), filename: f.name }))));
  return Response.json({ saved: rows.filter(Boolean).length, docs: rows.filter(Boolean).map((r) => ({ title: r!.title, folder: r!.folder })) });
}
