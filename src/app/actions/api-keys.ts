"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { newApiKey } from "@/lib/public-api";

/** Новый ключ API: показывается один раз, хранится только хэш. */
export async function createApiKey(input: { name: string; scope: "read" | "write"; clientIds: string[] | null }): Promise<{ key?: string; error?: string }> {
  const me = await requireAdmin();
  const d = z.object({ name: z.string().trim().min(1).max(100), scope: z.enum(["read", "write"]), clientIds: z.array(z.string().max(64)).max(500).nullable() }).safeParse(input);
  if (!d.success) return { error: "invalid" };
  const { key, prefix, hash } = newApiKey();
  await db.insert(apiKeys).values({ name: d.data.name, prefix, keyHash: hash, scope: d.data.scope, clientIds: d.data.clientIds, createdBy: me.id });
  refresh();
  return { key };
}

export async function revokeApiKey(id: string) {
  await requireAdmin();
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
  refresh();
}
