"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { campaignRuns, campaigns, type CampaignSegment } from "@/db/schema";

import { requireClient, requireClientAnd, requireOwned } from "@/lib/access";
export type CampaignResult = { error?: string; id?: string; count?: number };

const segmentSchema = z.object({
  agentIds: z.array(z.string()).max(50).optional(),
  channelTypes: z.array(z.string()).max(10).optional(),
  temperature: z.array(z.enum(["hot", "warm", "cold"])).optional(),
  contains: z.string().trim().max(100).optional(),
  activeWithinDays: z.number().int().min(1).max(3650).optional(),
  inactiveForDays: z.number().int().min(1).max(3650).optional(),
  hadHandoff: z.boolean().optional(),
});

const schema = z.object({
  kind: z.enum(["broadcast", "sequence"]),
  name: z.string().trim().min(1).max(100),
  segment: segmentSchema,
  steps: z
    .array(z.object({ delayHours: z.number().min(0).max(24 * 60), mode: z.enum(["text", "ai"]), text: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(10),
  trigger: z.enum(["idle", "handoff", "booking", "hot"]).nullable(),
  scheduleAt: z.number().nullable(),
  options: z.object({ quietHours: z.boolean(), optOutHint: z.boolean() }),
});

export async function saveCampaign(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<CampaignResult> {
  await requireClientAnd(clientId, "campaign", id);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const path = String(parsed.error.issues[0]?.path[0] ?? "");
    return { error: path === "steps" ? "steps" : "invalid" };
  }
  const d = parsed.data;
  if (d.kind === "sequence" && !d.trigger) return { error: "trigger" };
  const values = {
    kind: d.kind,
    name: d.name,
    segment: d.segment,
    steps: d.steps,
    trigger: d.kind === "sequence" ? d.trigger : null,
    scheduleAt: d.kind === "broadcast" && d.scheduleAt ? new Date(d.scheduleAt) : null,
    options: d.options,
    updatedAt: new Date(),
  };
  if (id) {
    const [cur] = await db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.clientId, clientId)));
    if (!cur) return { error: "not_found" };
    // Запущенную рассылку не меняем — только остановить
    if (cur.kind === "broadcast" && cur.status !== "draft") return { error: "launched" };
    await db.update(campaigns).set(values).where(eq(campaigns.id, id));
    refresh();
    return { id };
  }
  const [row] = await db.insert(campaigns).values({ clientId, ...values }).returning({ id: campaigns.id });
  refresh();
  return { id: row.id };
}

export async function deleteCampaign(id: string) {
  await requireOwned("campaign", id);
  await db.delete(campaigns).where(eq(campaigns.id, id));
  refresh();
}

/** Кому уйдёт: число и первые имена. */
export async function previewSegment(clientId: string, segment: CampaignSegment): Promise<{ count: number; sample: string[] }> {
  await requireClient(clientId);
  const s = segmentSchema.safeParse(segment);
  if (!s.success) return { count: 0, sample: [] };
  const { matchSegment } = await import("@/lib/campaigns/engine");
  const list = await matchSegment(clientId, s.data);
  return { count: list.length, sample: list.slice(0, 8).map((x) => `${x.contactName || "—"} · ${x.channelType}`) };
}

/** Какой текст получит первый подходящий клиент (ничего не отправляется). */
export async function previewMessage(id: string, step = 0): Promise<{ text?: string; error?: string }> {
  await requireOwned("campaign", id);
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!c) return { error: "not_found" };
  const { matchSegment, previewStep } = await import("@/lib/campaigns/engine");
  const [first] = await matchSegment(c.clientId, c.segment);
  if (!first) return { error: "empty" };
  const r = await previewStep(c, step, first.id);
  return "text" in r ? { text: r.text } : { error: r.skip };
}

/** Рассылка: поставить сообщения всем из сегмента (сразу или ко времени). */
export async function launchCampaign(id: string): Promise<CampaignResult> {
  await requireOwned("campaign", id);
  const { launchBroadcast } = await import("@/lib/campaigns/engine");
  const count = await launchBroadcast(id);
  refresh();
  return { count };
}

/** Цепочка: включить (набирает участников с этого момента) или выключить. */
export async function setSequenceEnabled(id: string, enabled: boolean): Promise<CampaignResult> {
  await requireOwned("campaign", id);
  await db
    .update(campaigns)
    .set({ enabled, status: enabled ? "active" : "paused", ...(enabled ? { enabledAt: new Date() } : {}), updatedAt: new Date() })
    .where(and(eq(campaigns.id, id), eq(campaigns.kind, "sequence")));
  refresh();
  return {};
}

/** Остановить: ничего больше не отправлять. */
export async function stopCampaign(id: string): Promise<CampaignResult> {
  await requireOwned("campaign", id);
  await db.update(campaigns).set({ enabled: false, status: "paused", updatedAt: new Date() }).where(eq(campaigns.id, id));
  await db.update(campaignRuns).set({ status: "stopped", error: "stopped_by_user" }).where(and(eq(campaignRuns.campaignId, id), eq(campaignRuns.status, "pending")));
  refresh();
  return {};
}
