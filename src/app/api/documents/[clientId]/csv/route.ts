import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { clientDocTypes, clientDocuments, conversations } from "@/db/schema";
import { requireUser } from "@/lib/auth";

import { canAccess } from "@/lib/access";
import { studioTz } from "@/lib/general";
/** Разобранные документы клиента одного типа — таблицей CSV (?type=<id>; Excel: «;», UTF-8 с BOM). */
export async function GET(req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  await requireUser();
  const { clientId } = await params;
  if (!(await canAccess("client", clientId))) return new Response("Forbidden", { status: 403 });
  const typeId = new URL(req.url).searchParams.get("type") ?? "";
  const [docType] = await db.select().from(clientDocTypes).where(eq(clientDocTypes.id, typeId));
  if (!docType || docType.clientId !== clientId) return new Response("not found", { status: 404 });
  const rows = await db
    .select({ d: clientDocuments, contact: conversations.contactName })
    .from(clientDocuments)
    .leftJoin(conversations, eq(conversations.id, clientDocuments.conversationId))
    .where(eq(clientDocuments.docTypeId, typeId))
    .orderBy(asc(clientDocuments.createdAt));
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fmt = new Intl.DateTimeFormat("ru-RU", { timeZone: studioTz(), dateStyle: "short", timeStyle: "short" });
  const head = ["Дата", "Клиент", "Файл", ...docType.fields.map((f) => f.label), "Кратко"];
  const lines = rows.map(({ d, contact }) => [fmt.format(d.createdAt), contact ?? "", d.filename, ...docType.fields.map((f) => d.fields[f.key] ?? ""), d.summary].map(cell).join(";"));
  const body = "﻿" + [head.map(cell).join(";"), ...lines].join("\r\n");
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${docType.name}.csv`)}` },
  });
}
