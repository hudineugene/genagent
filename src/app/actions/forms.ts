"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientForms } from "@/db/schema";

import { requireClientAnd, requireOwned } from "@/lib/access";
export type FormResult = { error?: string; id?: string };

const fieldSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/i),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["text", "choice", "number", "phone", "email", "rating", "date"]),
  options: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  required: z.boolean(),
  correct: z.string().trim().max(200).optional(),
  points: z.number().int().min(0).max(100).optional(),
});

const schema = z.object({
  kind: z.enum(["form", "quiz"]),
  name: z.string().trim().min(1).max(100),
  purpose: z.string().trim().max(1000),
  fields: z.array(fieldSchema).min(1).max(30),
  thanks: z.string().trim().max(1000),
  notify: z.boolean(),
  enabled: z.boolean(),
});

export async function saveForm(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<FormResult> {
  await requireClientAnd(clientId, "form", id);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "fields") ? "fields" : "invalid" };
  const d = parsed.data;
  if (new Set(d.fields.map((f) => f.key)).size !== d.fields.length) return { error: "fields" };
  if (d.fields.some((f) => f.type === "choice" && !f.options?.length)) return { error: "options" };
  const fields = d.fields.map((f) => ({ ...f, options: f.type === "choice" ? f.options : undefined, correct: d.kind === "quiz" && f.correct ? f.correct : undefined, points: d.kind === "quiz" && f.correct ? (f.points ?? 1) : undefined }));
  const values = { kind: d.kind, name: d.name, purpose: d.purpose, fields, thanks: d.thanks, notify: d.notify, enabled: d.enabled, updatedAt: new Date() };
  if (id) {
    await db.update(clientForms).set(values).where(and(eq(clientForms.id, id), eq(clientForms.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(clientForms).values({ clientId, ...values }).returning({ id: clientForms.id });
  refresh();
  return { id: row.id };
}

export async function deleteForm(id: string) {
  await requireOwned("form", id);
  await db.delete(clientForms).where(eq(clientForms.id, id));
  refresh();
}
