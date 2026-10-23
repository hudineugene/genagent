/** Логистика: разбор точек, распределение по машинам (вес и объём), маршрут Google Routes с оптимальным порядком
 *  и временем прибытия, расчёт доставки агентом, ошибки без ключа. Google — макет.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-logistics.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clientLogistics } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const reqs: { body: { intermediates?: unknown[]; optimizeWaypointOrder?: boolean; departureTime?: string; destination?: { address: string } }; key: string; mask: string }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      reqs.push({ body: b, key: String(req.headers["x-goog-api-key"]), mask: String(req.headers["x-goog-fieldmask"]) });
      res.writeHead(200, { "content-type": "application/json" });
      if (!b.intermediates) return res.end(JSON.stringify({ routes: [{ distanceMeters: 23456, duration: "1500s" }] }));
      // Три точки: Google говорит, что лучше порядок 2, 0, 1; каждый отрезок — 10 мин и 5 км
      const n = b.intermediates.length;
      res.end(JSON.stringify({ routes: [{ distanceMeters: 5000 * (n + 1), duration: `${600 * (n + 1)}s`, optimizedIntermediateWaypointIndex: n === 3 ? [2, 0, 1] : [...Array(n).keys()], legs: Array.from({ length: n + 1 }, () => ({ distanceMeters: 5000, duration: "600s" })) }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(4061, r));
  process.env.GOOGLE_ROUTES_URL = "http://127.0.0.1:4061/route";
  process.env.GOOGLE_MAPS_API_KEY = "maps-stub";

  const { parseStops, planLoad, routeFrom, deliveryTool } = await import("@/lib/logistics/routes");
  const stops = parseStops("Иван; Benidorm 1; 120; 0,8\n\nАнна; Altea 5; 40; 0.3\nVillajoyosa 3");
  const load = planLoad(
    [
      { name: "Малая", capacityKg: 150, capacityM3: 1 },
      { name: "Большая", capacityKg: 0, capacityM3: 0 },
    ],
    [...stops, { name: "Пианино", address: "Calpe", kg: 400, m3: 2 }],
  );
  const loadTight = planLoad([{ name: "Малая", capacityKg: 100, capacityM3: 1 }], [{ name: "Тяжёлый", address: "x", kg: 300, m3: 1 }]);

  const dep = Date.now() + 3600_000;
  const r = await routeFrom("Склад, Finestrat", stops, { departure: dep, stopMinutes: 15, returnToBase: true });
  const r2 = await routeFrom("Склад, Finestrat", stops, { departure: dep, stopMinutes: 15, returnToBase: false });

  const [agent] = await db.select().from(agents).limit(1);
  await db.delete(clientLogistics).where(eq(clientLogistics.clientId, agent.clientId));
  const noBase = await deliveryTool(agent.clientId).run({ address: "Altea" });
  await db.insert(clientLogistics).values({ clientId: agent.clientId, baseAddress: "Склад, Finestrat", deliveryNote: "Бесплатно до 30 км" });
  const est = await deliveryTool(agent.clientId).run({ address: "Calle Alicante 5, Altea" });
  delete process.env.GOOGLE_MAPS_API_KEY;
  let noKey = "";
  try {
    await routeFrom("x", stops, { departure: dep, stopMinutes: 0, returnToBase: true });
  } catch (e) {
    noKey = e instanceof Error ? e.message : "";
  }
  await db.delete(clientLogistics).where(eq(clientLogistics.clientId, agent.clientId));
  stub.close();

  const first = reqs[0];
  const result: Record<string, boolean> = {
    "точки: имя, адрес, вес с запятой, просто адрес": stops.length === 3 && stops[0].kg === 120 && stops[0].m3 === 0.8 && stops[2].address === "Villajoyosa 3" && stops[2].kg === 0,
    "загрузка: тяжёлое — в большую, лёгкое — в малую": load.loads.find((l) => l.vehicle.name === "Большая")?.stops.some((s) => s.name === "Пианино") === true && load.loads.find((l) => l.vehicle.name === "Малая")?.stops.some((s) => s.name === "Иван") === true && load.unassigned.length === 0,
    "загрузка: не помещается — в «не поместились»": loadTight.unassigned.length === 1 && loadTight.loads.length === 0,
    "запрос Google: ключ, поля, оптимизация, время выезда": first.key === "maps-stub" && first.mask.includes("optimizedIntermediateWaypointIndex") && first.body.optimizeWaypointOrder === true && first.body.intermediates?.length === 3 && first.body.departureTime === new Date(dep).toISOString(),
    "порядок от Google и время прибытия (10 мин в пути + 15 на точку)": r.stops.map((s) => s.name).join(",") === "3,Иван,Анна" && r.stops[0].eta === dep + 600_000 && r.stops[1].eta === dep + 600_000 + 900_000 + 600_000,
    "итог с возвращением: 20 км, 3×10 + 3×15 + 10 = 85 мин": r.km === 20 && r.minutes === 85 && r.mapsUrl.includes("waypoints="),
    "без возвращения: последний отрезок не считается": r2.km === 15 && r2.minutes === 60 && r2.mapsUrl.includes(encodeURIComponent("Altea 5")),
    "агент: без склада — честно, со складом — км, минуты, условия": noBase.includes("not configured") && est === "Distance: 23.5 km, driving time now: about 25 min. Delivery terms: Бесплатно до 30 км",
    "без ключа Google — понятная ошибка": noKey === "no_maps_key",
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
