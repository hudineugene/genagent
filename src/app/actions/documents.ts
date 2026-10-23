"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientDocTypes } from "@/db/schema";
import { requireUser } from "@/lib/auth";

export type DocTypeResult = { error?: string; id?: string };

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  purpose: z.string().trim().max(1000),
  fields: z
    .array(z.object({ key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/i), label: z.string().trim().min(1).max(100) }))
    .min(1)
    .max(30),
  notify: z.boolean(),
  enabled: z.boolean(),
});

export async function saveDocType(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<DocTypeResult> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "fields") ? "fields" : "invalid" };
  const d = parsed.data;
  if (new Set(d.fields.map((f) => f.key)).size !== d.fields.length) return { error: "fields" };
  const values = { ...d, updatedAt: new Date() };
  if (id) {
    await db.update(clientDocTypes).set(values).where(and(eq(clientDocTypes.id, id), eq(clientDocTypes.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(clientDocTypes).values({ clientId, ...values }).returning({ id: clientDocTypes.id });
  refresh();
  return { id: row.id };
}

export async function deleteDocType(id: string) {
  await requireUser();
  await db.delete(clientDocTypes).where(eq(clientDocTypes.id, id));
  refresh();
}
