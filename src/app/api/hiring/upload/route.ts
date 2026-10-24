import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vacancies } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { addCandidates } from "@/lib/hiring";
import { readDocument } from "@/lib/documents/intake";

const EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".html", ".htm"];

/** Резюме к вакансии (до 50 файлов): текст достаётся сразу, оценка идёт в фоне. Поля: vacancyId, files. */
export async function POST(req: Request) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const form = await req.formData();
  const vacancyId = String(form.get("vacancyId") ?? "");
  const [v] = await db.select({ id: vacancies.id }).from(vacancies).where(eq(vacancies.id, vacancyId));
  if (!v) return Response.json({ error: "not_found" }, { status: 404 });
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return Response.json({ error: "no_files" }, { status: 400 });
  if (files.length > 50) return Response.json({ error: "too_many" }, { status: 400 });
  const ok: { filename: string; text: string }[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (!EXTENSIONS.includes(path.extname(f.name).toLowerCase()) || f.size > 10 * 1024 * 1024) {
      skipped.push(f.name);
      continue;
    }
    const text = await readDocument(Buffer.from(await f.arrayBuffer()), f.name);
    if (text && text.length >= 50) ok.push({ filename: f.name, text });
    else skipped.push(f.name);
  }
  const added = ok.length ? await addCandidates(vacancyId, ok) : 0;
  return Response.json({ added, skipped });
}
