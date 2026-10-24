"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { PAY_PROVIDERS, clientPayments, payments, type PayCredentials } from "@/db/schema";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  provider: z.enum(PAY_PROVIDERS),
  publicKey: z.string().trim().max(200).default(""),
  privateKey: z.string().trim().max(200).default(""),
  merchant: z.string().trim().max(200).default(""),
  secret: z.string().trim().max(200).default(""),
  domain: z.string().trim().max(200).default(""),
  token: z.string().trim().max(300).default(""),
  currency: z.enum(["UAH", "USD", "EUR"]),
  maxAmount: z.number().positive().max(10_000_000).nullable(),
  paidText: z.string().trim().max(500).default(""),
  enabled: z.boolean(),
});
export type PaymentsInput = z.input<typeof schema>;

/** Сохранить эквайринг клиента. Пустые секретные поля — оставить прежние (в браузер они не отдаются). */
export async function savePayments(clientId: string, input: PaymentsInput): Promise<{ error?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const [cur] = await db.select().from(clientPayments).where(eq(clientPayments.clientId, clientId));
  const old: PayCredentials = cur?.provider === d.provider ? cur.credentials : {};
  const credentials: PayCredentials =
    d.provider === "liqpay"
      ? { publicKey: d.publicKey, privateKey: d.privateKey || old.privateKey }
      : d.provider === "wayforpay"
        ? { merchant: d.merchant, domain: d.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, ""), secret: d.secret || old.secret }
        : { token: d.token || old.token };
  const values = { provider: d.provider, credentials, currency: d.currency, maxAmount: d.maxAmount, paidText: d.paidText, enabled: d.enabled, updatedAt: new Date() };
  await db.insert(clientPayments).values({ clientId, ...values }).onConflictDoUpdate({ target: clientPayments.clientId, set: values });
  refresh();
  return {};
}

/** Пробная ссылка на 1 единицу валюты — проверить ключи и страницу оплаты банка. */
export async function testPaymentLink(clientId: string): Promise<{ link?: string; error?: string }> {
  await requireUser();
  const { createPayment } = await import("@/lib/payments");
  try {
    const r = await createPayment(clientId, { amount: 1, description: "Проверка оплаты" });
    refresh();
    return r.link ? { link: r.link } : { error: r.error };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Перепроверить статус оплаты у банка. */
export async function recheckPayment(id: string): Promise<{ status?: string }> {
  await requireUser();
  const [p] = await db.select().from(payments).where(eq(payments.id, id));
  if (!p) return {};
  const { refreshPayment } = await import("@/lib/payments");
  const status = await refreshPayment(p);
  refresh();
  return { status };
}
