"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { incidents, monitors } from "@/db/schema";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["http", "webhook"]),
  url: z.string().trim().max(1000),
  expectText: z.string().trim().max(200),
  maxMs: z.number().int().min(500).max(60_000),
  intervalMin: z.number().int().min(1).max(1440),
  failThreshold: z.number().int().min(1).max(10),
  audience: z.string().trim().max(500),
  enabled: z.boolean(),
});

export async function saveMonitor(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (d.kind === "http" && !/^https?:\/\/[^\s]+$/i.test(d.url)) return { error: "url" };
  const values = { ...d, updatedAt: new Date() };
  if (id) {
    await db.update(monitors).set(values).where(and(eq(monitors.id, id), eq(monitors.clientId, clientId)));
    refresh();
    return { id };
  }
  const { newMonitorKey } = await import("@/lib/monitor");
  const [row] = await db.insert(monitors).values({ clientId, ...values, apiKey: newMonitorKey() }).returning({ id: monitors.id });
  refresh();
  return { id: row.id };
}

export async function deleteMonitor(id: string) {
  await requireUser();
  await db.delete(monitors).where(eq(monitors.id, id));
  refresh();
}

export async function checkMonitorNow(id: string) {
  await requireUser();
  const [m] = await db.select().from(monitors).where(eq(monitors.id, id));
  if (!m) return null;
  const { runMonitor } = await import("@/lib/monitor");
  const r = await runMonitor(m);
  refresh();
  return r;
}

export async function renewMonitorKey(id: string) {
  await requireUser();
  const { newMonitorKey } = await import("@/lib/monitor");
  await db.update(monitors).set({ apiKey: newMonitorKey(), updatedAt: new Date() }).where(eq(monitors.id, id));
  refresh();
}

/** Черновик → рассылка (выключенная, проверить и запустить во вкладке «Рассылки»). */
export async function incidentToCampaign(incidentId: string, text: string, days: number, which: "draft" | "resolved"): Promise<{ error?: string; campaignId?: string }> {
  await requireUser();
  if (text.trim().length < 10) return { error: "short" };
  const { draftToCampaign } = await import("@/lib/monitor");
  const c = await draftToCampaign(incidentId, text.trim().slice(0, 3000), Math.min(90, Math.max(1, Math.round(days))), which);
  refresh();
  return c ? { campaignId: c.id } : { error: "not_found" };
}

export async function closeIncident(id: string) {
  await requireUser();
  await db.update(incidents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(incidents.id, id));
  refresh();
}
