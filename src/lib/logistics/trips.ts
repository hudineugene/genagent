import "server-only";
import { and, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, trips, type Trip, type TripStop } from "@/db/schema";
import type { ToolContext } from "@/lib/agent/tools";
import type { AgentTool } from "@/lib/llm";
import { apiKey, withKeys } from "@/lib/keys";
import { parseContact, reach } from "@/lib/reach";
import { callRoutes, getLogistics, seconds } from "./routes";

/**
 * Рейсы: маршрут водителю в мессенджер, отметки точек в чате с агентом, сообщения получателям («едем к вам»,
 * «задерживаемся до …», «доставлено»), прогноз задержек: пробки сейчас (Google Routes), погода на время рейса
 * (Open-Meteo, без ключа) и история прошлых рейсов клиента (насколько обычно опаздываем относительно плана).
 */
const DELAY_NOTIFY_MIN = 15;
const CHECK_EVERY_MS = 15 * 60_000;
const GEO_URL = () => process.env.OPEN_METEO_GEO_URL || "https://geocoding-api.open-meteo.com/v1/search";
const METEO_URL = () => process.env.OPEN_METEO_URL || "https://api.open-meteo.com/v1/forecast";

const hm = (ms: number) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(ms);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------- погода ----------

const geoCache = new Map<string, { lat: number; lon: number } | null>();

/** Координаты города из адреса: пробуем части адреса с конца («…, Киев, Украина» → «Киев»). */
async function geocode(address: string) {
  if (geoCache.has(address)) return geoCache.get(address)!;
  const parts = address.split(",").map((x) => x.replace(/\d+/g, "").trim()).filter((x) => x.length > 2);
  for (const name of [...parts].reverse()) {
    try {
      const r = await fetch(`${GEO_URL()}?name=${encodeURIComponent(name)}&count=1&language=ru`, { signal: AbortSignal.timeout(8000) });
      const j = (await r.json()) as { results?: { latitude: number; longitude: number }[] };
      const hit = j.results?.[0];
      if (hit) {
        const v = { lat: hit.latitude, lon: hit.longitude };
        geoCache.set(address, v);
        return v;
      }
    } catch {
      /* следующая часть */
    }
  }
  geoCache.set(address, null);
  return null;
}

export type Weather = { factor: number; text: string };

/** Погода на время рейса → во сколько раз дольше ехать и что сказать. */
export function weatherFactor(h: { precipitation: number; snowfall: number; wind: number; visibility: number | null }): Weather {
  let factor = 1;
  const why: string[] = [];
  if (h.snowfall >= 0.5) {
    factor += h.snowfall >= 2 ? 0.4 : 0.25;
    why.push(`снег ${h.snowfall} см/ч`);
  } else if (h.precipitation >= 2) {
    factor += h.precipitation >= 6 ? 0.2 : 0.1;
    why.push(`дождь ${h.precipitation} мм/ч`);
  }
  if (h.wind >= 50) {
    factor += 0.1;
    why.push(`ветер ${Math.round(h.wind)} км/ч`);
  }
  if (h.visibility != null && h.visibility < 1000) {
    factor += 0.15;
    why.push(`видимость ${Math.round(h.visibility)} м`);
  }
  return { factor: Math.round(factor * 100) / 100, text: why.join(", ") };
}

export async function weatherAt(address: string, at: number): Promise<Weather | null> {
  const geo = await geocode(address);
  if (!geo) return null;
  try {
    const r = await fetch(`${METEO_URL()}?latitude=${geo.lat}&longitude=${geo.lon}&hourly=precipitation,snowfall,wind_speed_10m,visibility&timezone=UTC&forecast_days=3`, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { hourly?: { time: string[]; precipitation: number[]; snowfall: number[]; wind_speed_10m: number[]; visibility?: number[] } };
    const h = j.hourly;
    if (!h?.time?.length) return null;
    const target = new Date(at).toISOString().slice(0, 13);
    const i = Math.max(0, h.time.findIndex((t) => t.startsWith(target)));
    return weatherFactor({ precipitation: h.precipitation[i] ?? 0, snowfall: h.snowfall[i] ?? 0, wind: h.wind_speed_10m[i] ?? 0, visibility: h.visibility?.[i] ?? null });
  } catch {
    return null;
  }
}

// ---------- история ----------

/** Насколько дольше плана обычно едем (медиана по точкам завершённых рейсов за 60 дней; меньше 5 точек — 1). */
export async function historyFactor(clientId: string) {
  const done = await db
    .select({ departure: trips.departure, stops: trips.stops })
    .from(trips)
    .where(and(eq(trips.clientId, clientId), eq(trips.status, "done"), gte(trips.departure, new Date(Date.now() - 60 * 86400_000))));
  const ratios: number[] = [];
  for (const t of done)
    for (const s of t.stops) {
      const plan = s.eta - t.departure.getTime();
      if (s.status === "done" && s.doneAt && plan > 5 * 60_000) ratios.push((s.doneAt - t.departure.getTime()) / plan);
    }
  if (ratios.length < 5) return 1;
  ratios.sort((a, b) => a - b);
  return Math.min(2, Math.max(0.8, Math.round(ratios[Math.floor(ratios.length / 2)] * 100) / 100));
}

// ---------- прогноз ----------

/**
 * Новое время по оставшимся точкам: от последней отмеченной точки (или склада) сейчас, с пробками; поездки
 * удлиняются по погоде и истории. Без ключа Google — плановые отрезки, сдвинутые на текущее опоздание.
 */
async function forecastTrip__(t: Trip, now = Date.now()) {
  const l = await getLogistics(t.clientId);
  const pending = t.stops.map((s, i) => ({ s, i })).filter((x) => x.s.status === "pending");
  if (!pending.length || !l?.baseAddress) return { stops: t.stops, risk: "" };
  const lastDone = [...t.stops.keys()].filter((i) => t.stops[i].status !== "pending").pop();
  const origin = lastDone != null ? t.stops[lastDone].address : l.baseAddress;
  const start = Math.max(now, lastDone != null ? (t.stops[lastDone].doneAt ?? now) : t.departure.getTime());
  const [weather, history] = await Promise.all([weatherAt(l.baseAddress, start), historyFactor(t.clientId)]);
  const factor = (weather?.factor ?? 1) * history;
  let legs: number[] = [];
  if (apiKey("googleMaps")) {
    try {
      const route = await callRoutes(
        {
          origin: { address: origin },
          destination: { address: pending.at(-1)!.s.address },
          intermediates: pending.slice(0, -1).map((x) => ({ address: x.s.address })),
          routingPreference: "TRAFFIC_AWARE",
          departureTime: new Date(Math.max(start, Date.now() + 60_000)).toISOString(),
        },
        "routes.legs.duration",
      );
      legs = (route.legs ?? []).map((g) => seconds(g.duration) * 1000);
    } catch (e) {
      console.error("trip forecast route failed", e instanceof Error ? e.message : e);
    }
  }
  if (legs.length !== pending.length) {
    // Плановые отрезки между точками
    legs = pending.map((x, k) => {
      const prevEta = k === 0 ? (lastDone != null ? t.stops[lastDone].eta + l.stopMinutes * 60_000 : t.departure.getTime()) : pending[k - 1].s.eta + l.stopMinutes * 60_000;
      return Math.max(0, x.s.eta - prevEta);
    });
  }
  let clock = start;
  const stops = [...t.stops];
  pending.forEach((x, k) => {
    clock += legs[k] * factor;
    stops[x.i] = { ...x.s, forecast: Math.round(clock) };
    clock += l.stopMinutes * 60_000;
  });
  const risk = [weather?.text ? `погода: ${weather.text}` : "", history > 1.05 ? `обычно дольше плана на ${Math.round((history - 1) * 100)}%` : ""].filter(Boolean).join("; ");
  return { stops, risk };
}

export async function forecastTrip(t: Trip, now = Date.now()) {
  return withKeys({ clientId: t.clientId }, () => forecastTrip__(t, now));
}

// ---------- сообщения ----------

async function tell(t: Trip, s: TripStop, text: string) {
  if (!t.notifyCustomers || !s.contact) return false;
  const out = await reach(t.clientId, parseContact(s.contact), { text, subject: "Доставка", name: s.name, meta: { campaign: { id: t.id, name: "Доставка", step: 0 } } }).catch((e) => {
    console.error("trip notify failed", e);
    return { status: "failed" as const };
  });
  return out.status === "sent";
}

async function save(t: Trip, patch: Partial<Trip>) {
  const [row] = await db.update(trips).set({ ...patch, updatedAt: new Date() }).where(eq(trips.id, t.id)).returning();
  return row;
}

export function routeText(t: Trip) {
  return [
    `🚚 Маршрут${t.name ? ` «${t.name}»` : ""}${t.vehicle ? ` · ${t.vehicle}` : ""}`,
    `Выезд: ${hm(t.departure.getTime())}. ${t.km} км, ~${Math.floor(t.minutes / 60)} ч ${t.minutes % 60} мин.`,
    "",
    ...t.stops.map((s, i) => `${i + 1}. ${hm(s.eta)} — ${s.name !== String(i + 1) ? `${s.name}, ` : ""}${s.address}${s.contact ? ` (${s.contact})` : ""}${s.kg ? `, ${s.kg} кг` : ""}`),
    "",
    t.instructions ? `Инструкции: ${t.instructions}\n` : "",
    `Карта: ${t.mapsUrl}`,
    "",
    "Пишите сюда, когда доставите: «1 доставлено», «2 не застал — перезвонить вечером». Я отмечу и сообщу получателю.",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/** Отправить маршрут водителю (или обновление). */
export async function sendToDriver(tripId: string, extra?: string) {
  const [t] = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!t) return { status: "not_found" as const };
  if (!t.driver) return { status: "no_driver" as const };
  const text = extra ? `🚚 Обновление по маршруту${t.name ? ` «${t.name}»` : ""}:\n${extra}` : routeText(t);
  const out = await reach(t.clientId, parseContact(t.driver), { text, subject: "Маршрут", name: t.driverName });
  if (out.status === "sent" && !extra) await save(t, { status: t.status === "planned" ? "sent" : t.status, sentAt: new Date() });
  return out;
}

/** Отметка точки водителем или в студии: получателю — «доставлено», следующему — «едем к вам». */
export async function markStop(tripId: string, index: number, status: "done" | "failed", note = "", now = Date.now()) {
  const [t] = await db.select().from(trips).where(eq(trips.id, tripId));
  if (!t || !t.stops[index]) return null;
  const stops = t.stops.map((s, i) => (i === index ? { ...s, status, doneAt: now, note: note.slice(0, 300) } : s));
  const s = stops[index];
  if (status === "done" && !s.told?.done && (await tell(t, s, `✅ Ваш заказ${s.name && s.name !== String(index + 1) ? ` (${s.name})` : ""} доставлен. Спасибо!`))) stops[index] = { ...s, told: { ...s.told, done: true } };
  const finished = stops.every((x) => x.status !== "pending");
  let row = await save(t, { stops, status: finished ? "done" : "active" });
  if (!finished) {
    // Следующему — «едем к вам» с прогнозом
    const f = await forecastTrip(row, now);
    const next = f.stops.findIndex((x) => x.status === "pending");
    const n = f.stops[next];
    if (n && !n.told?.onWay && (await tell(row, n, `🚚 Курьер едет к вам${n.address ? ` (${n.address})` : ""}, будет примерно в ${hm(n.forecast ?? n.eta)}.`)))
      f.stops[next] = { ...n, told: { ...n.told, onWay: true } };
    row = await save(row, { stops: f.stops, risk: f.risk, lastCheckAt: new Date(now) });
  } else {
    const failed = stops.filter((x) => x.status === "failed");
    const n = await import("@/lib/notify/telegram");
    const html = `🏁 <b>Рейс завершён</b>${t.name ? ` · ${esc(t.name)}` : ""}${t.driverName ? ` · ${esc(t.driverName)}` : ""}\nДоставлено: ${stops.length - failed.length} из ${stops.length}${failed.length ? `\nНе доставлено: ${failed.map((x) => `${esc(x.name)}${x.note ? ` — ${esc(x.note)}` : ""}`).join("; ")}` : ""}`;
    await n.sendToTeam(html).catch(() => {});
    await n.sendToOwners(t.clientId, html).catch(() => {});
  }
  return row;
}

/** Каждые 10 минут: рейсы в пути и на сегодня — прогноз; задержка ≥ 15 мин — получателю и команде. */
export async function tripsTick(now = Date.now()) {
  const list = await db
    .select()
    .from(trips)
    .where(and(inArray(trips.status, ["sent", "active"]), gte(trips.departure, new Date(now - 18 * 3600_000))));
  let told = 0;
  for (const t of list) {
    if (t.departure.getTime() > now + 2 * 3600_000) continue;
    if (t.lastCheckAt && now - t.lastCheckAt.getTime() < CHECK_EVERY_MS) continue;
    try {
      const f = await forecastTrip(t, now);
      const stops = [...f.stops];
      const late: string[] = [];
      for (let i = 0; i < stops.length; i++) {
        const s = stops[i];
        if (s.status !== "pending" || !s.forecast) continue;
        const delay = Math.round((s.forecast - s.eta) / 60_000);
        if (delay < DELAY_NOTIFY_MIN || delay < (s.told?.delayMin ?? 0) + DELAY_NOTIFY_MIN) continue;
        late.push(`${esc(s.name)} — +${delay} мин (≈${hm(s.forecast)})`);
        if (await tell(t, s, `⏳ Доставка задерживается${f.risk ? ` (${f.risk.replace(/^погода: /, "")})` : ""}. Ожидаемое время — около ${hm(s.forecast)}. Приносим извинения!`)) {
          stops[i] = { ...s, told: { ...s.told, delayMin: delay } };
          told++;
        } else stops[i] = { ...s, told: { ...s.told, delayMin: delay } };
      }
      await save(t, { stops, risk: f.risk, lastCheckAt: new Date(now) });
      if (late.length) {
        const n = await import("@/lib/notify/telegram");
        const html = `⏳ <b>Задержка доставки</b>${t.name ? ` · ${esc(t.name)}` : ""}${t.driverName ? ` · ${esc(t.driverName)}` : ""}\n${late.join("\n")}${f.risk ? `\nПричина: ${esc(f.risk)}` : ""}`;
        await n.sendToTeam(html).catch(() => {});
        await n.sendToOwners(t.clientId, html).catch(() => {});
      }
    } catch (e) {
      console.error("trip check failed", t.id, e);
    }
  }
  return told;
}

/** Сводка по доставкам за N дней: рейсы, точки, вовремя (до +15 мин), среднее опоздание, км, не доставлено. */
export async function tripStats(clientId: string, days = 30) {
  const list = await db
    .select()
    .from(trips)
    .where(and(eq(trips.clientId, clientId), gte(trips.departure, new Date(Date.now() - days * 86400_000))));
  let stops = 0;
  let done = 0;
  let failed = 0;
  let onTime = 0;
  let delaySum = 0;
  let km = 0;
  for (const t of list) {
    km += t.km;
    for (const s of t.stops) {
      stops++;
      if (s.status === "failed") failed++;
      if (s.status === "done" && s.doneAt) {
        done++;
        const d = (s.doneAt - s.eta) / 60_000;
        if (d <= DELAY_NOTIFY_MIN) onTime++;
        delaySum += Math.max(0, d);
      }
    }
  }
  return { trips: list.length, stops, done, failed, onTimePct: done ? Math.round((onTime / done) * 100) : null, avgDelayMin: done ? Math.round(delaySum / done) : null, km: Math.round(km) };
}

// ---------- инструменты агента ----------

const keysOfConv = (c: { contactHandle: string; externalId: string }) => ({ handle: c.contactHandle.replace(/^@/, "").toLowerCase(), digits: c.externalId.replace(/\D/g, ""), ext: c.externalId.toLowerCase() });
const sameContact = (raw: string, k: ReturnType<typeof keysOfConv>) => {
  const p = parseContact(raw);
  return Boolean((p.telegram && p.telegram.replace(/^@/, "").toLowerCase() === k.handle) || (p.phone.length >= 9 && k.digits.endsWith(p.phone.slice(-9))) || (p.email && p.email === k.ext));
};

async function convKeys(ctx: ToolContext) {
  if (!ctx.conversationId) return null;
  const [c] = await db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
  return c ? keysOfConv(c) : null;
}

async function activeTrips(clientId: string) {
  return db
    .select()
    .from(trips)
    .where(and(eq(trips.clientId, clientId), inArray(trips.status, ["planned", "sent", "active"]), gte(trips.departure, new Date(Date.now() - 24 * 3600_000))));
}

export async function hasActiveTrips(clientId: string) {
  return (await activeTrips(clientId)).length > 0;
}

export function tripTools(ctx: ToolContext & { clientId: string }): AgentTool[] {
  const driverTrip = async () => {
    const k = await convKeys(ctx);
    if (!k) return null;
    return (await activeTrips(ctx.clientId)).find((t) => t.driver && sameContact(t.driver, k)) ?? null;
  };
  return [
    {
      name: "trip_route",
      description: "For a DRIVER: their current delivery route — stops in order with planned times, addresses, recipient contacts and status. Use when the driver asks about the route or next stop.",
      inputSchema: { type: "object", properties: {} },
      parse: z.object({}).passthrough(),
      run: async () => {
        if (ctx.mode !== "live") return "[Test mode: 1. 10:30 Иван, ул. Шевченко 1 — pending]";
        const t = await driverTrip();
        if (!t) return "This person has no active route.";
        return t.stops.map((s, i) => `${i + 1}. ${hm(s.eta)} ${s.name}, ${s.address}${s.contact ? ` (${s.contact})` : ""} — ${s.status}${s.note ? ` (${s.note})` : ""}`).join("\n") + (t.instructions ? `\nInstructions: ${t.instructions}` : "");
      },
    },
    {
      name: "trip_stop_update",
      description: "For a DRIVER: mark a stop of their route as delivered (done) or not delivered (failed, with the reason) when they report it, e.g. «2 доставлено», «3 не застал». The recipient is notified automatically and the next recipient gets «courier is on the way».",
      inputSchema: {
        type: "object",
        properties: { stop: { type: "integer", description: "Stop number in the route (1-based)" }, status: { type: "string", enum: ["done", "failed"] }, note: { type: "string" } },
        required: ["stop", "status"],
      },
      parse: z.object({ stop: z.number().int().min(1).max(100), status: z.enum(["done", "failed"]), note: z.string().max(300).optional() }),
      run: async (input) => {
        const x = input as { stop: number; status: "done" | "failed"; note?: string };
        if (ctx.mode !== "live") return `[Test mode: stop ${x.stop} marked ${x.status}]`;
        const t = await driverTrip();
        if (!t) return "This person has no active route.";
        if (!t.stops[x.stop - 1]) return `No stop ${x.stop}; the route has ${t.stops.length} stops.`;
        const row = await markStop(t.id, x.stop - 1, x.status, x.note ?? "");
        const next = row?.stops.find((s) => s.status === "pending");
        return row?.status === "done" ? "Marked. All stops are done — the route is finished." : `Marked. Next: ${next ? `${next.name}, ${next.address}, about ${hm(next.forecast ?? next.eta)}` : "—"}.`;
      },
    },
    {
      name: "delivery_status",
      description: "For a CUSTOMER: where their delivery is — stage (on the way / delivered / not delivered) and the expected arrival time. Use when they ask «где мой заказ», «когда привезёте».",
      inputSchema: { type: "object", properties: {} },
      parse: z.object({}).passthrough(),
      run: async () => {
        if (ctx.mode !== "live") return "[Test mode: on the way, expected about 14:20]";
        const k = await convKeys(ctx);
        if (!k) return "No delivery found for this chat.";
        for (const t of await activeTrips(ctx.clientId)) {
          const s = t.stops.find((x) => x.contact && sameContact(x.contact, k));
          if (!s) continue;
          const pos = t.stops.indexOf(s);
          const before = t.stops.slice(0, pos).filter((x) => x.status === "pending").length;
          if (s.status === "done") return `Delivered at ${hm(s.doneAt ?? s.eta)}.`;
          if (s.status === "failed") return `Delivery attempt failed${s.note ? `: ${s.note}` : ""} — the manager will contact them.`;
          if (t.status === "planned") return `Scheduled for today, planned around ${hm(s.eta)}; the courier has not left yet.`;
          return `On the way. Stops before theirs: ${before}. Expected about ${hm(s.forecast ?? s.eta)}${s.forecast && s.forecast - s.eta > DELAY_NOTIFY_MIN * 60_000 ? ` (delayed${t.risk ? `: ${t.risk}` : ""})` : ""}.`;
        }
        return "No delivery found for this chat today — say the manager will check.";
      },
    },
  ];
}
