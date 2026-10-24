"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { docTemplates } from "@/db/schema";

import { requireClientAnd, requireOwned } from "@/lib/access";
export type DocTemplateResult = { error?: string; id?: string };

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  purpose: z.string().trim().max(1000),
  body: z.string().trim().min(1).max(30_000),
  fields: z.array(z.object({ key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/i), label: z.string().trim().min(1).max(200) })).max(40),
  enabled: z.boolean(),
});

const BUILTIN = new Set(["date", "number", "client"]);

export async function saveDocTemplate(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<DocTemplateResult> {
  await requireClientAnd(clientId, "docTemplate", id);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "fields") ? "fields" : "invalid" };
  const d = parsed.data;
  // Поля берём из текста шаблона: {{key}} без встроенных; подписи — из формы
  const keys = [...new Set([...d.body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].filter((k) => !BUILTIN.has(k));
  const labels = new Map(d.fields.map((f) => [f.key, f.label]));
  const fields = keys.map((k) => ({ key: k, label: labels.get(k) ?? k }));
  const values = { name: d.name, purpose: d.purpose, body: d.body, fields, enabled: d.enabled, updatedAt: new Date() };
  if (id) {
    await db.update(docTemplates).set(values).where(and(eq(docTemplates.id, id), eq(docTemplates.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(docTemplates).values({ clientId, ...values }).returning({ id: docTemplates.id });
  refresh();
  return { id: row.id };
}

export async function deleteDocTemplate(id: string) {
  await requireOwned("docTemplate", id);
  await db.delete(docTemplates).where(eq(docTemplates.id, id));
  refresh();
}
