"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clientBilling } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";

const schema = z.object({
  currency: z.string().trim().min(1).max(5),
  usdRate: z.number().positive().max(100000),
  fee: z.number().min(0).max(10_000_000),
  markupPct: z.number().min(0).max(1000),
  channelMarkupPct: z.number().min(0).max(1000),
  includedUsd: z.number().min(0).max(1_000_000),
  limitUsd: z.number().positive().max(1_000_000).nullable(),
});
export type BillingInput = z.input<typeof schema>;

/** Условия клиента (только администратор: маржа и цены — не для всех сотрудников). */
export async function saveBilling(clientId: string, input: BillingInput): Promise<{ error?: string }> {
  await requireAdmin();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const values = { ...parsed.data, currency: parsed.data.currency.toUpperCase(), alerted: "", updatedAt: new Date() };
  await db.insert(clientBilling).values({ clientId, ...values }).onConflictDoUpdate({ target: clientBilling.clientId, set: values });
  refresh();
  return {};
}
