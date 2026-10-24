import "server-only";
import { apiKey } from "@/lib/keys";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientLogistics, type Vehicle } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";

/**
 * Логистика: маршрут с оптимальным порядком точек и временем прибытия (Google Routes API, ключ Google Maps
 * из «Внешних сервисов»), распределение заказов по машинам (вес и объём — считает код), расчёт доставки для агента.
 */
const ROUTES_URL = () => process.env.GOOGLE_ROUTES_URL || "https://routes.googleapis.com/directions/v2:computeRoutes";
/** Google оптимизирует до 25 промежуточных точек */
export const MAX_STOPS = 25;

export type Stop = { name: string; address: string; kg: number; m3: number };
/** eta и back — время в мс (часовой пояс показа выбирает браузер) */
export type RouteStop = Stop & { eta: number; legKm: number; legMin: number };
export type PlannedRoute = { vehicle: string; stops: RouteStop[]; km: number; minutes: number; back: number; mapsUrl: string; kg: number; m3: number };

/** «Имя; адрес; кг; м³» или просто адрес — по строке на точку. */
export function parseStops(text: string): Stop[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const parts = l.split(";").map((x) => x.trim());
      if (parts.length === 1) return { name: `${i + 1}`, address: parts[0], kg: 0, m3: 0 };
      const num = (s?: string) => Math.max(0, Number((s ?? "").replace(",", ".")) || 0);
      return { name: parts[0] || `${i + 1}`, address: parts[1] || parts[0], kg: num(parts[2]), m3: num(parts[3]) };
    });
}

/** Распределить заказы по машинам: сначала самые тяжёлые, каждый — в первую машину, где хватает веса и объёма. 0 — без ограничения. */
export function planLoad(vehicles: Vehicle[], stops: Stop[]) {
  const load = vehicles.map((v) => ({ vehicle: v, stops: [] as Stop[], kg: 0, m3: 0 }));
  const unassigned: Stop[] = [];
  for (const s of [...stops].sort((a, b) => b.kg - a.kg || b.m3 - a.m3)) {
    const fit = load.find((l) => (!l.vehicle.capacityKg || l.kg + s.kg <= l.vehicle.capacityKg) && (!l.vehicle.capacityM3 || l.m3 + s.m3 <= l.vehicle.capacityM3 + 1e-9));
    if (!fit) {
      unassigned.push(s);
      continue;
    }
    fit.stops.push(s);
    fit.kg += s.kg;
    fit.m3 += s.m3;
  }
  return { loads: load.filter((l) => l.stops.length), unassigned };
}

type RoutesResponse = {
  routes?: { distanceMeters?: number; duration?: string; optimizedIntermediateWaypointIndex?: number[]; legs?: { distanceMeters?: number; duration?: string }[] }[];
  error?: { message?: string };
};

async function callRoutes(body: object, mask: string): Promise<NonNullable<RoutesResponse["routes"]>[number]> {
  const key = apiKey("googleMaps");
  if (!key) throw new Error("no_maps_key");
  const res = await fetch(ROUTES_URL(), {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask },
    body: JSON.stringify({ travelMode: "DRIVE", languageCode: "ru", units: "METRIC", ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as RoutesResponse;
  if (!res.ok) throw new Error(data.error?.message?.slice(0, 300) || `Google Routes: HTTP ${res.status}`);
  const route = data.routes?.[0];
  if (!route) throw new Error("no_route");
  return route;
}

const seconds = (d?: string) => Number((d ?? "0s").replace("s", "")) || 0;
const mapsLink = (origin: string, dest: string, points: string[]) =>
  `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}${points.length ? `&waypoints=${encodeURIComponent(points.join("|"))}` : ""}`;

/** Маршрут со склада по всем точкам в лучшем порядке; время прибытия с учётом пробок и времени на точку. */
export async function routeFrom(base: string, stops: Stop[], o: { departure: number; stopMinutes: number; returnToBase: boolean; vehicle?: string }): Promise<PlannedRoute> {
  if (!stops.length) throw new Error("no_stops");
  if (stops.length > MAX_STOPS) throw new Error("too_many_stops");
  const departure = Math.max(o.departure, Date.now() + 60_000);
  const route = await callRoutes(
    {
      origin: { address: base },
      destination: { address: base },
      intermediates: stops.map((s) => ({ address: s.address })),
      routingPreference: "TRAFFIC_AWARE",
      optimizeWaypointOrder: stops.length > 1,
      departureTime: new Date(departure).toISOString(),
    },
    "routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex,routes.legs.distanceMeters,routes.legs.duration",
  );
  const order = route.optimizedIntermediateWaypointIndex?.length === stops.length ? route.optimizedIntermediateWaypointIndex : stops.map((_, i) => i);
  const legs = route.legs ?? [];
  let t = departure;
  let km = 0;
  const planned: RouteStop[] = order.map((idx, i) => {
    const leg = legs[i];
    t += seconds(leg?.duration) * 1000;
    km += (leg?.distanceMeters ?? 0) / 1000;
    const stop = { ...stops[idx], eta: t, legKm: Math.round((leg?.distanceMeters ?? 0) / 100) / 10, legMin: Math.round(seconds(leg?.duration) / 60) };
    t += o.stopMinutes * 60_000;
    return stop;
  });
  const backLeg = legs[stops.length];
  if (o.returnToBase && backLeg) {
    t += seconds(backLeg.duration) * 1000;
    km += (backLeg.distanceMeters ?? 0) / 1000;
  } else t -= o.stopMinutes * 60_000;
  const addresses = planned.map((s) => s.address);
  return {
    vehicle: o.vehicle ?? "",
    stops: planned,
    km: Math.round(km * 10) / 10,
    minutes: Math.round((t - departure) / 60_000),
    back: t,
    mapsUrl: o.returnToBase ? mapsLink(base, base, addresses) : mapsLink(base, addresses.at(-1)!, addresses.slice(0, -1)),
    kg: planned.reduce((n, s) => n + s.kg, 0),
    m3: Math.round(planned.reduce((n, s) => n + s.m3, 0) * 100) / 100,
  };
}

export async function getLogistics(clientId: string) {
  const [l] = await db.select().from(clientLogistics).where(eq(clientLogistics.clientId, clientId));
  return l ?? null;
}

/** Расстояние и время в пути от склада до адреса клиента — инструмент агента. */
export function deliveryTool(clientId: string): AgentTool {
  return {
    name: "delivery_estimate",
    description: "Distance and current driving time from the company's warehouse/office to the customer's address, plus the company's delivery terms. Use when the customer asks about delivery time, cost or distance. Ask for the full address (city, street, house) first.",
    inputSchema: { type: "object", properties: { address: { type: "string", description: "Customer's full address" } }, required: ["address"] },
    parse: z.object({ address: z.string().trim().min(3).max(300) }),
    run: async (input) => {
      const l = await getLogistics(clientId);
      if (!l?.baseAddress) return "Delivery calculation is not configured — say the manager will calculate it.";
      const route = await callRoutes(
        { origin: { address: l.baseAddress }, destination: { address: (input as { address: string }).address }, routingPreference: "TRAFFIC_AWARE" },
        "routes.distanceMeters,routes.duration",
      );
      const km = Math.round((route.distanceMeters ?? 0) / 100) / 10;
      const min = Math.round(seconds(route.duration) / 60);
      return `Distance: ${km} km, driving time now: about ${min} min.${l.deliveryNote ? ` Delivery terms: ${l.deliveryNote}` : " Delivery terms are not set — do not name a price."}`;
    },
  };
}
