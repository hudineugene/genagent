import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, kbSources } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { ExtractError, MAX_FILE_BYTES, extractFile } from "@/lib/kb/extract";
import { indexSource } from "@/lib/kb/store";

import { canAccess } from "@/lib/access";
/**
 * Загрузка файлов в базу знаний клиента: извлекаем текст, режем на фрагменты, индексируем.
 * Источник создаётся только для успешно прочитанных файлов; ошибки возвращаются списком.
 */
export async function POST(req: Request) {
  const user = await findCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  if (!(await canAccess("client", clientId))) return new Response("Forbidden", { status: 403 });
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
  if (!client) return Response.json({ error: "client_not_found" }, { status: 404 });

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  const results: { name: string; ok: boolean; error?: string; chunks?: number }[] = [];

  for (const file of files) {
    try {
      if (file.size > MAX_FILE_BYTES) throw new ExtractError("too_large");
      const { text, pages } = await extractFile(Buffer.from(await file.arrayBuffer()), file.name);
      if (!text.trim()) throw new ExtractError("no_text");

      const title = file.name.replace(/\.[^.]+$/, "");
      const [s] = await db
        .insert(kbSources)
        .values({ clientId, type: "file", title, filename: file.name, pages, createdBy: user.id })
        .returning({ id: kbSources.id });
      const { chunks } = indexSource(s.id, clientId, title, text);
      results.push({ name: file.name, ok: true, chunks });
    } catch (e) {
      if (!(e instanceof ExtractError)) console.error("kb upload failed", file.name, e);
      results.push({ name: file.name, ok: false, error: e instanceof ExtractError ? e.message : "parse_failed" });
    }
  }

  return Response.json({ results });
}
