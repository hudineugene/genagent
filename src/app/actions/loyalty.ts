"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { loyaltyAccounts, loyaltyPrograms } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { adjust, ensureAccount, getProgram, newApiKey, normContact } from "@/lib/loyalty/engine";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(30),
  rules: z.string().trim().max(3000),
  rewards: z.array(z.object({ name: z.string().trim().min(1).max(200), cost: z.number().int().min(1).max(10_000_000) })).max(30),
  welcome: z.number().int().min(0).max(1_000_000),
  notifyCustomer: z.boolean(),
  enabled: z.boolean(),
});

export async function saveProgram(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "rewards") ? "rewards" : "invalid" };
  if (id) {
    await db
      .update(loyaltyPrograms)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(loyaltyPrograms.id, id), eq(loyaltyPrograms.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(loyaltyPrograms).values({ clientId, ...parsed.data, apiKey: newApiKey() }).returning({ id: loyaltyPrograms.id });
  refresh();
  return { id: row.id };
}

export async function renewProgramKey(id: string) {
  await requireUser();
  await db.update(loyaltyPrograms).set({ apiKey: newApiKey(), updatedAt: new Date() }).where(eq(loyaltyPrograms.id, id));
  refresh();
}

const adjustSchema = z.object({
  contact: z.string().trim().min(1).max(200),
  name: z.string().trim().max(100),
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0),
  reason: z.string().trim().max(300),
});

/** Начислить или списать вручную (существующему счёту или новому по контакту). */
export async function adjustPoints(programId: string, input: z.input<typeof adjustSchema>): Promise<{ error?: string; balance?: number }> {
  await requireUser();
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const p = await getProgram(programId);
  if (!p) return { error: "not_found" };
  const contact = normContact(parsed.data.contact);
  if (!contact) return { error: "invalid" };
  const { account } = await ensureAccount(p, [contact], { name: parsed.data.name || undefined });
  const r = await adjust(p, account, parsed.data.delta, parsed.data.reason, "studio");
  refresh();
  return "error" in r ? { error: r.error } : { balance: r.account.balance };
}

export async function deleteAccount(id: string) {
  await requireUser();
  await db.delete(loyaltyAccounts).where(eq(loyaltyAccounts.id, id));
  refresh();
}
