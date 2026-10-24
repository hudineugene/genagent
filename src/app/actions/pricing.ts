"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clientPricing } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { calcQuote, formatQuote, getPricing } from "@/lib/pricing";
import { refreshTable } from "@/lib/data/tables";

const schema = z.object({
  tableId: z.string().nullable(),
  nameColumn: z.string().max(200),
  priceColumn: z.string().max(200),
  tierBy: z.enum(["amount", "qty"]),
  tiers: z.array(z.object({ from: z.number().min(0).max(1e12), percent: z.number().min(0).max(100) })).max(20),
  vat: z.number().min(0).max(100),
  currency: z.string().trim().min(1).max(10),
  notes: z.string().trim().max(1000),
});

export async function savePricing(clientId: string, input: z.input<typeof schema>): Promise<{ error?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const values = { ...parsed.data, updatedAt: new Date() };
  await db.insert(clientPricing).values({ clientId, ...values }).onConflictDoUpdate({ target: clientPricing.clientId, set: values });
  refresh();
  return {};
}

/** Пробный расчёт: строки «название; количество». */
export async function testQuote(clientId: string, lines: string): Promise<{ text?: string; error?: string }> {
  await requireUser();
  const found = await getPricing(clientId);
  if (!found) return { error: "not_configured" };
  const items = lines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, qty] = l.split(";").map((x) => x.trim());
      return { name, qty: Number((qty ?? "1").replace(",", ".")) || 1 };
    });
  if (!items.length) return { error: "no_items" };
  try {
    const table = await refreshTable(found.table);
    return { text: formatQuote(calcQuote(found.pricing, table, items), found.pricing.notes) };
  } catch (e) {
    return { error: e instanceof Error && e.message === "columns" ? "columns" : "failed" };
  }
}
