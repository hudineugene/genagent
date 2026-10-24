"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { onboardingPlans, onboardings } from "@/db/schema";
import { requireUser } from "@/lib/auth";

const planSchema = z.object({
  name: z.string().trim().min(1).max(100),
  steps: z
    .array(z.object({ title: z.string().trim().min(1).max(200), day: z.number().int().min(0).max(90), kind: z.enum(["task", "meet", "read"]), owner: z.string().trim().max(100) }))
    .max(60),
  welcome: z.string().trim().max(2000),
});

export async function savePlan(clientId: string, id: string | null, input: z.input<typeof planSchema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const values = { ...parsed.data, updatedAt: new Date() };
  if (id) {
    await db.update(onboardingPlans).set(values).where(and(eq(onboardingPlans.id, id), eq(onboardingPlans.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(onboardingPlans).values({ clientId, ...values }).returning({ id: onboardingPlans.id });
  refresh();
  return { id: row.id };
}

export async function deletePlan(id: string) {
  await requireUser();
  await db.delete(onboardingPlans).where(eq(onboardingPlans.id, id));
  refresh();
}

const newSchema = z.object({
  planId: z.string().max(64).nullable(),
  name: z.string().trim().min(1).max(100),
  role: z.string().trim().max(100),
  contact: z.string().trim().max(100),
  email: z.string().trim().max(200),
  channelId: z.string().max(64).nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(2000),
  personalize: z.boolean(),
});

/** Новый сотрудник: чек-лист, приветствие (сразу), ежедневные напоминания. */
export async function startOnboarding(clientId: string, input: z.input<typeof newSchema>): Promise<{ error?: string; welcome?: string }> {
  await requireUser();
  const parsed = newSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (!d.contact && !d.email) return { error: "contact" };
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return { error: "email" };
  const { createOnboarding } = await import("@/lib/onboarding");
  const created = await createOnboarding(clientId, { ...d, planId: d.planId || null, channelId: d.channelId || null });
  const [row] = await db.select({ s: onboardings.welcomeStatus }).from(onboardings).where(eq(onboardings.id, created.id));
  refresh();
  return { welcome: row?.s };
}

export async function toggleOnboardingItem(id: string, itemId: string, done: boolean) {
  await requireUser();
  const { markItem } = await import("@/lib/onboarding");
  await markItem(id, itemId, done);
  refresh();
}

export async function resendOnboardingWelcome(id: string) {
  await requireUser();
  const { resendWelcome } = await import("@/lib/onboarding");
  const status = await resendWelcome(id);
  refresh();
  return status;
}

export async function deleteOnboarding(id: string) {
  await requireUser();
  await db.delete(onboardings).where(eq(onboardings.id, id));
  refresh();
}
