"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clientLogistics } from "@/db/schema";
import { withKeys } from "@/lib/keys";
import { MAX_STOPS, getLogistics, parseStops, planLoad, routeFrom, type PlannedRoute, type Stop } from "@/lib/logistics/routes";

import { requireClient } from "@/lib/access";
const settingsSchema = z.object({
  baseAddress: z.string().trim().max(300),
  stopMinutes: z.number().int().min(0).max(240),
  vehicles: z.array(z.object({ name: z.string().trim().min(1).max(60), capacityKg: z.number().min(0).max(100_000), capacityM3: z.number().min(0).max(1000) })).max(30),
  deliveryNote: z.string().trim().max(2000),
});

export async function saveLogistics(clientId: string, input: z.input<typeof settingsSchema>): Promise<{ error?: string }> {
  await requireClient(clientId);
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const values = { ...parsed.data, updatedAt: new Date() };
  await db
    .insert(clientLogistics)
    .values({ clientId, ...values })
    .onConflictDoUpdate({ target: clientLogistics.clientId, set: values });
  refresh();
  return {};
}

const planSchema = z.object({
  stops: z.string().max(20_000),
  departure: z.number(),
  returnToBase: z.boolean(),
  split: z.boolean(),
});

/** Маршруты на день: по одному или с распределением заказов по машинам (вес / объём). */
async function planRoutes__(clientId: string, input: z.input<typeof planSchema>): Promise<{ error?: string; routes?: PlannedRoute[]; unassigned?: Stop[] }> {
  await requireClient(clientId);
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const l = await getLogistics(clientId);
  if (!l?.baseAddress) return { error: "no_base" };
  const stops = parseStops(parsed.data.stops);
  if (!stops.length) return { error: "no_stops" };
  const o = { departure: parsed.data.departure, stopMinutes: l.stopMinutes, returnToBase: parsed.data.returnToBase };
  try {
    if (parsed.data.split && l.vehicles.length) {
      const { loads, unassigned } = planLoad(l.vehicles, stops);
      if (loads.some((x) => x.stops.length > MAX_STOPS)) return { error: "too_many_stops" };
      const routes = await Promise.all(loads.map((x) => routeFrom(l.baseAddress, x.stops, { ...o, vehicle: x.vehicle.name })));
      return { routes, unassigned };
    }
    if (stops.length > MAX_STOPS) return { error: "too_many_stops" };
    return { routes: [await routeFrom(l.baseAddress, stops, o)], unassigned: [] };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m !== "no_maps_key") console.error("route planning failed", m);
    return { error: ["no_maps_key", "no_route", "too_many_stops"].includes(m) ? m : `google:${m}` };
  }
}

export async function planRoutes(...a: Parameters<typeof planRoutes__>): ReturnType<typeof planRoutes__> {
  return withKeys({ clientId: a[0] }, () => planRoutes__(...a));
}
