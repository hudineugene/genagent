"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { routines } from "@/db/schema";
import { requireUser } from "@/lib/auth";

export type RoutineResult = { error?: string; id?: string };

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversations"), days: z.number().int().min(1).max(90), agentIds: z.array(z.string()).max(50).optional() }),
  z.object({ type: z.literal("sheet"), url: z.string().trim().min(1).max(1000), sheet: z.string().trim().max(100) }),
  z.object({ type: z.literal("url"), url: z.string().trim().url().max(1000) }),
  z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("table"), tableId: z.string().min(1).max(64) }),
]);

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  task: z.string().trim().min(1).max(3000),
  schedule: z.object({
    freq: z.enum(["daily", "weekly", "monthly"]),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).optional(),
    day: z.number().int().min(1).max(31).optional(),
  }),
  sources: z.array(sourceSchema).max(10),
  delivery: z.object({ team: z.boolean(), owners: z.boolean() }),
  enabled: z.boolean(),
});

export async function saveRoutine(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<RoutineResult> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "sources") ? "sources" : "invalid" };
  const d = parsed.data;
  if (!d.delivery.team && !d.delivery.owners) return { error: "delivery" };
  const values = { ...d, updatedAt: new Date() };
  if (id) {
    await db.update(routines).set(values).where(and(eq(routines.id, id), eq(routines.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(routines).values({ clientId, ...values }).returning({ id: routines.id });
  refresh();
  return { id: row.id };
}

export async function deleteRoutine(id: string) {
  await requireUser();
  await db.delete(routines).where(eq(routines.id, id));
  refresh();
}

/** Запустить сейчас (и отправить, как по расписанию) — для проверки. */
export async function runRoutineNow(id: string): Promise<{ ok: boolean; text: string }> {
  await requireUser();
  const { runRoutine } = await import("@/lib/routines/engine");
  const r = await runRoutine(id);
  refresh();
  return r;
}
