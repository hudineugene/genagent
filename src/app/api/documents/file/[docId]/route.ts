import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clientDocuments } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { ARCHIVE_NAME, DOCS_DIR } from "@/lib/documents/archive";

import { canAccess } from "@/lib/access";
const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
};

/** Скачать документ из архива под единым именем (только для сотрудников студии). */
export async function GET(_req: Request, { params }: { params: Promise<{ docId: string }> }) {
  await requireUser();
  const { docId } = await params;
  if (!(await canAccess("document", docId))) return new Response("Forbidden", { status: 403 });
  const [d] = await db.select().from(clientDocuments).where(eq(clientDocuments.id, docId));
  if (!d?.file || !ARCHIVE_NAME.test(d.file)) return new Response("not found", { status: 404 });
  const full = path.join(DOCS_DIR, d.file);
  if (!fs.existsSync(full)) return new Response("not found", { status: 404 });
  const ext = path.extname(d.file);
  return new Response(fs.readFileSync(full), {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(d.title || d.filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
