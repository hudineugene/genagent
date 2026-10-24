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
  // Мастер нового клиента: «Сразу создать агента» — на мастер агента этого клиента
  redirect(formData.get("next") === "agent" ? `/clients/${c.id}/agents/new` : `/clients/${c.id}`);
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

/** Свой логотип клиента (PNG, JPEG или WEBP до 1 МБ) — вместо значка с его сайта. */
export async function uploadClientLogo(clientId: string, formData: FormData): Promise<{ error?: string }> {
  await requireClient(clientId);
  const file = formData.get("logo");
  if (!(file instanceof File) || !file.size) return { error: "empty" };
  const { MAX_LOGO_BYTES, imageType, saveCustomLogo } = await import("@/lib/client-logo");
  if (file.size > MAX_LOGO_BYTES) return { error: "too_big" };
  const data = Buffer.from(await file.arrayBuffer());
  if (!imageType(data)) return { error: "type" };
  await saveCustomLogo(clientId, data);
  refresh();
  return {};
}

export async function removeClientLogo(clientId: string) {
  await requireClient(clientId);
  const { removeCustomLogo } = await import("@/lib/client-logo");
  await removeCustomLogo(clientId);
  refresh();
}
