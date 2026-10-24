import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, dataTables } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { DATA_EXTENSIONS, buildTable, readDataFile } from "@/lib/data/tables";

import { canAccess } from "@/lib/access";
const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Загрузка таблицы данных (CSV / Excel): новая таблица или замена данных существующей (tableId).
 * Поля формы: clientId, file, name?, description?, sheet? (лист Excel), tableId?
 */
export async function POST(req: Request) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  if (!(await canAccess("client", clientId))) return new Response("Forbidden", { status: 403 });
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
  if (!client) return Response.json({ error: "client_not_found" }, { status: 404 });
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 400 });
  if (!DATA_EXTENSIONS.includes(path.extname(file.name).toLowerCase())) return Response.json({ error: "unsupported" }, { status: 400 });

  let table: ReturnType<typeof buildTable>;
  try {
    table = buildTable(readDataFile(Buffer.from(await file.arrayBuffer()), file.name, String(form.get("sheet") ?? "") || undefined));
  } catch (e) {
    console.error("data upload parse failed", file.name, e instanceof Error ? e.message : e);
    return Response.json({ error: "parse_failed" }, { status: 400 });
  }
  if (!table.columns.length || !table.rows.length) return Response.json({ error: "empty" }, { status: 400 });

  const values = { columns: table.columns, rows: table.rows, rowCount: table.rows.length, filename: file.name.slice(0, 200), refreshedAt: new Date(), error: null, updatedAt: new Date() };
  const tableId = String(form.get("tableId") ?? "");
  if (tableId) {
    const [row] = await db
      .update(dataTables)
      .set({ ...values, source: "file" })
      .where(and(eq(dataTables.id, tableId), eq(dataTables.clientId, clientId)))
      .returning({ id: dataTables.id });
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ id: row.id, rows: values.rowCount, columns: table.columns });
  }
  const name = String(form.get("name") ?? "").trim().slice(0, 100) || file.name.replace(/\.[^.]+$/, "").slice(0, 100);
  const description = String(form.get("description") ?? "").trim().slice(0, 1000);
  const [row] = await db.insert(dataTables).values({ clientId, name, description, source: "file", ...values }).returning({ id: dataTables.id });
  return Response.json({ id: row.id, rows: values.rowCount, columns: table.columns });
}
