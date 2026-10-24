"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { trips } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { withKeys } from "@/lib/keys";

const stopSchema = z.object({
  name: z.string().max(200),
  address: z.string().max(300),
  kg: z.number(),
  m3: z.number(),
  contact: z.string().max(200).optional(),
  eta: z.number(),
  legKm: z.number().optional(),
  legMin: z.number().optional(),
});
const schema = z.object({
  name: z.string().trim().max(100),
  driver: z.string().trim().max(100),
  driverName: z.string().trim().max(100),
  instructions: z.string().trim().max(2000),
  notifyCustomers: z.boolean(),
  sendNow: z.boolean(),
  route: z.object({ vehicle: z.string().max(100), stops: z.array(stopSchema).min(1).max(30), km: z.number(), minutes: z.number(), mapsUrl: z.string().max(4000) }),
  departure: z.number(),
  returnToBase: z.boolean(),
});

/** Сохранить построенный маршрут как рейс (и сразу отправить водителю). */
export async function saveTrip(clientId: string, input: z.input<typeof schema>): Promise<{ error?: string; id?: string; sent?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const [row] = await db
    .insert(trips)
    .values({
      clientId,
      name: d.name,
      vehicle: d.route.vehicle,
      driver: d.driver,
      driverName: d.driverName,
      departure: new Date(d.departure),
      returnToBase: d.returnToBase,
      stops: d.route.stops.map((s) => ({ name: s.name, address: s.address, kg: s.kg, m3: s.m3, contact: (s.contact ?? "").trim(), eta: s.eta, status: "pending" as const })),
      km: d.route.km,
      minutes: d.route.minutes,
      mapsUrl: d.route.mapsUrl,
      instructions: d.instructions,
      notifyCustomers: d.notifyCustomers,
    })
    .returning({ id: trips.id });
  let sent: string | undefined;
  if (d.sendNow && d.driver) {
    const { sendToDriver } = await import("@/lib/logistics/trips");
    sent = (await sendToDriver(row.id)).status;
  }
  refresh();
  return { id: row.id, sent };
}

export async function sendTrip(id: string, extra?: string) {
  await requireUser();
  const { sendToDriver } = await import("@/lib/logistics/trips");
  const r = await sendToDriver(id, extra?.trim() ? extra.trim().slice(0, 2000) : undefined);
  refresh();
  return r.status;
}

export async function markTripStop(id: string, index: number, status: "done" | "failed", note = "") {
  await requireUser();
  const [t] = await db.select({ clientId: trips.clientId }).from(trips).where(eq(trips.id, id));
  if (!t) return;
  const { markStop } = await import("@/lib/logistics/trips");
  await withKeys({ clientId: t.clientId }, () => markStop(id, index, status, note.slice(0, 300)));
  refresh();
}

/** Пересчитать прогноз сейчас (без сообщений получателям). */
export async function forecastTripNow(id: string) {
  await requireUser();
  const [t] = await db.select().from(trips).where(eq(trips.id, id));
  if (!t) return;
  const { forecastTrip } = await import("@/lib/logistics/trips");
  const f = await forecastTrip(t);
  await db.update(trips).set({ stops: f.stops, risk: f.risk, updatedAt: new Date() }).where(and(eq(trips.id, id)));
  refresh();
}

export async function deleteTrip(id: string) {
  await requireUser();
  await db.delete(trips).where(eq(trips.id, id));
  refresh();
}
