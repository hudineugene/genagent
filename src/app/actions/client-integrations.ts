"use server";

import { randomBytes } from "node:crypto";
import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { INTEGRATION_EVENTS, clientIntegrations } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { spreadsheetId } from "@/lib/google/sheets";

export type IntegrationResult = { error?: string; id?: string };

const schema = z.object({
  kind: z.enum(["sheet", "webhook"]),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().max(1000),
  sheet: z.string().trim().max(100).default(""),
  events: z.array(z.enum(INTEGRATION_EVENTS)).min(1),
  enabled: z.boolean(),
});

export async function saveIntegration(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<IntegrationResult> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "events") ? "events" : "invalid" };
  const d = parsed.data;
  if (d.kind === "sheet" && !spreadsheetId(d.url)) return { error: "sheet_bad_url" };
  if (d.kind === "webhook") {
    try {
      const u = new URL(d.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "url" };
    } catch {
      return { error: "url" };
    }
  }
  const [existing] = id
    ? await db.select().from(clientIntegrations).where(and(eq(clientIntegrations.id, id), eq(clientIntegrations.clientId, clientId)))
    : [];
  // Секрет вебхука создаётся один раз и не меняется при правке
  const secret = existing && existing.kind === "webhook" ? (existing.config as { secret: string }).secret : randomBytes(24).toString("hex");
  const config = d.kind === "sheet" ? { url: d.url, sheet: d.sheet || "Лист1" } : { url: d.url, secret };
  const values = { kind: d.kind, name: d.name, config, events: d.events, enabled: d.enabled, updatedAt: new Date() };
  if (existing) {
    await db.update(clientIntegrations).set(values).where(eq(clientIntegrations.id, existing.id));
    refresh();
    return { id: existing.id };
  }
  const [row] = await db.insert(clientIntegrations).values({ clientId, ...values }).returning({ id: clientIntegrations.id });
  refresh();
  return { id: row.id };
}

export async function deleteIntegration(id: string) {
  await requireUser();
  await db.delete(clientIntegrations).where(eq(clientIntegrations.id, id));
  refresh();
}

/** Пробная отправка: строка в таблицу или пример заявки на вебхук. */
export async function testIntegration(id: string): Promise<{ ok: boolean; error?: string }> {
  await requireUser();
  const [row] = await db.select().from(clientIntegrations).where(eq(clientIntegrations.id, id));
  if (!row) return { ok: false, error: "not_found" };
  const { sendTest } = await import("@/lib/integrations/events");
  try {
    await sendTest(row);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    refresh();
  }
}
