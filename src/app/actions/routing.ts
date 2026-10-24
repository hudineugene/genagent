"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { routingRules } from "@/db/schema";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  chatIds: z.array(z.string().max(40)).min(1).max(20),
});

export async function saveRoutingRule(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<{ error?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "chatIds") ? "no_people" : "invalid" };
  if (id) await db.update(routingRules).set(parsed.data).where(and(eq(routingRules.id, id), eq(routingRules.clientId, clientId)));
  else await db.insert(routingRules).values({ clientId, ...parsed.data, position: Date.now() % 1_000_000 });
  refresh();
  return {};
}

export async function deleteRoutingRule(id: string) {
  await requireUser();
  await db.delete(routingRules).where(eq(routingRules.id, id));
  refresh();
}
