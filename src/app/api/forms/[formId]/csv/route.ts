import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { clientForms, conversations, formResponses } from "@/db/schema";
import { requireUser } from "@/lib/auth";

/** Ответы анкеты таблицей CSV (Excel открывает: разделитель «;», UTF-8 с BOM). */
export async function GET(_req: Request, { params }: { params: Promise<{ formId: string }> }) {
  await requireUser();
  const { formId } = await params;
  const [form] = await db.select().from(clientForms).where(eq(clientForms.id, formId));
  if (!form) return new Response("not found", { status: 404 });
  const rows = await db
    .select({ r: formResponses, contact: conversations.contactName, handle: conversations.contactHandle })
    .from(formResponses)
    .leftJoin(conversations, eq(conversations.id, formResponses.conversationId))
    .where(eq(formResponses.formId, formId))
    .orderBy(asc(formResponses.createdAt));
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Дата", "Клиент", "Контакт", ...form.fields.map((f) => f.label), ...(form.kind === "quiz" ? ["Баллы"] : [])];
  const fmt = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short" });
  const lines = rows.map(({ r, contact, handle }) =>
    [fmt.format(r.createdAt), contact ?? "", handle ?? "", ...form.fields.map((f) => r.answers[f.key] ?? ""), ...(form.kind === "quiz" ? [`${r.score ?? ""}/${r.maxScore ?? ""}`] : [])].map(cell).join(";"),
  );
  const body = "﻿" + [head.map(cell).join(";"), ...lines].join("\r\n");
  const name = encodeURIComponent(`${form.name}.csv`);
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${name}` } });
}
