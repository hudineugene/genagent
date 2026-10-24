"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { procedures, type ProcedureStep } from "@/db/schema";
import { requireClientAnd, requireOwned } from "@/lib/access";

const key = z.string().trim().regex(/^[a-z][a-z0-9_]{0,29}$/);
const text = z.string().trim().min(1).max(2000);
const step = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask"), key, question: text, type: z.enum(["text", "phone", "email", "number", "date", "choice"]), options: z.array(z.string().trim().min(1).max(100)).max(12).optional() }),
  z.object({ kind: z.literal("tool"), toolId: z.string().min(1).max(64), action: z.enum(["find", "order"]).optional(), args: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/i), z.string().max(500)), saveAs: key }),
  z.object({ kind: z.literal("approval"), subject: z.string().trim().min(1).max(200), details: z.string().trim().max(3000), amount: z.string().trim().max(100).optional(), rejected: z.string().trim().max(1000) }),
  z.object({ kind: z.literal("say"), text }),
  z.object({ kind: z.literal("handoff"), text }),
]);
const schema = z.object({
  name: z.string().trim().min(1).max(100),
  trigger: z.string().trim().min(1).max(500),
  steps: z.array(step).min(1).max(30),
  enabled: z.boolean(),
});
export type ProcedureInput = z.input<typeof schema>;

export async function saveProcedure(clientId: string, id: string | null, input: ProcedureInput): Promise<{ error?: string; id?: string }> {
  await requireClientAnd(clientId, "procedure", id);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  // Ключи ответов — разные; вопрос с выбором — с вариантами
  const keys = d.steps.flatMap((s) => (s.kind === "ask" ? [s.key] : s.kind === "tool" ? [s.saveAs] : []));
  if (new Set(keys).size !== keys.length) return { error: "keys" };
  if (d.steps.some((s) => s.kind === "ask" && s.type === "choice" && !(s.options?.length ?? 0))) return { error: "options" };
  const values = { name: d.name, trigger: d.trigger, steps: d.steps as ProcedureStep[], enabled: d.enabled, updatedAt: new Date() };
  if (id) {
    await db.update(procedures).set(values).where(eq(procedures.id, id));
    refresh();
    return { id };
  }
  const [row] = await db.insert(procedures).values({ clientId, ...values }).returning({ id: procedures.id });
  refresh();
  return { id: row.id };
}

export async function deleteProcedure(id: string) {
  await requireOwned("procedure", id);
  await db.delete(procedures).where(eq(procedures.id, id));
  refresh();
}
