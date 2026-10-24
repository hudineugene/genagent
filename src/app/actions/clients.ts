"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { removeIndexForClient } from "@/lib/kb/store";

import { requireClient, requireUnscoped } from "@/lib/access";
const clientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(200).default(""),
  website: z.string().trim().max(500).default(""),
  description: z.string().trim().max(20000).default(""),
  brandVoice: z.string().trim().max(5000).default(""),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1"),
});

function parse(formData: FormData) {
  return clientSchema.parse(Object.fromEntries(formData));
}

export async function createClient(formData: FormData) {
  await requireUnscoped();
  const [c] = await db.insert(clients).values(parse(formData)).returning({ id: clients.id });
  redirect(`/clients/${c.id}`);
}

export async function updateClient(id: string, formData: FormData) {
  await requireClient(id);
  await db.update(clients).set(parse(formData)).where(eq(clients.id, id));
  redirect(`/clients/${id}`);
}

export async function deleteClient(id: string) {
  await requireClient(id);
  removeIndexForClient(id);
  await db.delete(clients).where(eq(clients.id, id));
  refresh();
  redirect("/clients");
}

/** Срок хранения разговоров клиента (GDPR): null — бессрочно, иначе 7–3650 дней. */
export async function saveRetention(clientId: string, days: number | null): Promise<{ error?: string }> {
  await requireClient(clientId);
  if (days != null && (!Number.isInteger(days) || days < 7 || days > 3650)) return { error: "invalid" };
  await db.update(clients).set({ retentionDays: days }).where(eq(clients.id, clientId));
  refresh();
  return {};
}
