/** Рейсы: маршрут водителю в Telegram, прогноз задержки (пробки + погода), сообщения получателям («задерживаемся»,
 *  «доставлено», «едем к вам»), отметки водителя через агента, «где мой заказ», сводка. Google, Open-Meteo и
 *  Telegram — макеты.  DB_PATH=<копия caltest> npx tsx scripts/test-trips.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientLogistics, clients, conversations, trips } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  let meteoCalls = 0;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/bot")) {
        const b = JSON.parse(body || "{}");
        if (req.url.endsWith("/sendMessage")) tg.push({ chat: String(b.chat_id), text: b.text });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      if (req.url?.startsWith("/geo")) return res.end(JSON.stringify({ results: req.url.includes("Kyiv") ? [{ latitude: 50.45, longitude: 30.52 }] : [] }));
      if (req.url?.startsWith("/meteo")) {
        meteoCalls++;
        const now = new Date();
        const time = Array.from({ length: 48 }, (_, i) => new Date(now.getTime() + (i - 2) * 3600_000).toISOString().slice(0, 13) + ":00");
        return res.end(JSON.stringify({ hourly: { time, precipitation: time.map(() => 0), snowfall: time.map(() => 2), wind_speed_10m: time.map(() => 10), visibility: time.map(() => 20000) } }));
      }
      // Google Routes: каждый отрезок 20 минут
      const b = JSON.parse(body || "{}");
      const n = (b.intermediates?.length ?? 0) + 1;
      res.end(JSON.stringify({ routes: [{ distanceMeters: 5000 * n, duration: `${1200 * n}s`, legs: Array.from({ length: n }, () => ({ distanceMeters: 5000, duration: "1200s" })) }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(4071, r));
  process.env.GOOGLE_ROUTES_URL = "http://127.0.0.1:4071/route";
  process.env.GOOGLE_MAPS_API_KEY = "maps-stub";
  process.env.OPEN_METEO_GEO_URL = "http://127.0.0.1:4071/geo";
  process.env.OPEN_METEO_URL = "http://127.0.0.1:4071/meteo";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4071";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Trips Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "trips-agent" }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "123:t" } as never }).returning();
  const mk = (ext: string, name: string, handle: string) => db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "telegram", externalId: ext, contactName: name, contactHandle: handle }).returning();
  const [[driver], [anna], [boris]] = await Promise.all([mk("801", "Вася", "@driver_v"), mk("802", "Анна", "@anna_k"), mk("803", "Борис", "@boris")]);
  await db.insert(clientLogistics).values({ clientId: c.id, baseAddress: "Склад, ул. Промышленная 1, Kyiv", stopMinutes: 10 });

  const now = Date.now();
  const dep = now - 30 * 60_000;
  const [t] = await db
    .insert(trips)
    .values({
      clientId: c.id,
      name: "Утро",
      vehicle: "Газель",
      driver: "@driver_v",
      driverName: "Вася",
      departure: new Date(dep),
      stops: [
        { name: "Анна", address: "ул. Шевченко 1, Kyiv", kg: 5, m3: 0, contact: "@anna_k", eta: dep + 20 * 60_000, status: "pending" },
        { name: "Борис", address: "ул. Франко 2, Kyiv", kg: 3, m3: 0, contact: "@boris", eta: dep + 40 * 60_000, status: "pending" },
      ],
      km: 12,
      minutes: 60,
      mapsUrl: "https://maps.example/route",
      instructions: "Звонить за 10 минут",
    })
    .returning();

  const { sendToDriver, tripsTick, tripTools, tripStats, weatherFactor } = await import("@/lib/logistics/trips");
  const sent = await sendToDriver(t.id);
  const route = tg.find((x) => x.chat === "801");
  const [afterSend] = await db.select().from(trips).where(eq(trips.id, t.id));

  const told = await tripsTick(now);
  const annaDelay = tg.find((x) => x.chat === "802" && x.text.includes("задерживается"));
  const borisDelay = tg.find((x) => x.chat === "803" && x.text.includes("задерживается"));
  const teamDelay = tg.find((x) => x.text.includes("Задержка доставки"));
  const [afterTick] = await db.select().from(trips).where(eq(trips.id, t.id));
  const again = await tripsTick(now + 60_000);

  // Водитель отмечает точку через агента
  const tools = tripTools({ mode: "live", clientId: c.id, conversationId: driver.id, agentId: a.id });
  const list = await tools[0].run({});
  const r1 = await tools[1].run({ stop: 1, status: "done" });
  const annaDone = tg.find((x) => x.chat === "802" && x.text.includes("доставлен"));
  const borisOnWay = tg.find((x) => x.chat === "803" && x.text.includes("едет к вам"));
  const borisAsks = await tripTools({ mode: "live", clientId: c.id, conversationId: boris.id })[2].run({});
  const stranger = await tripTools({ mode: "live", clientId: c.id, conversationId: anna.id })[0].run({});
  const r2 = await tools[1].run({ stop: 2, status: "failed", note: "не было дома" });
  const finished = tg.find((x) => x.text.includes("Рейс завершён") && x.text.includes("не было дома"));
  const [final] = await db.select().from(trips).where(eq(trips.id, t.id));
  const stats = await tripStats(c.id);

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const result: Record<string, boolean> = {
    "погода → коэффициент: дождь, снег, ветер": weatherFactor({ precipitation: 3, snowfall: 0, wind: 10, visibility: null }).factor === 1.1 && weatherFactor({ precipitation: 0, snowfall: 2, wind: 60, visibility: 500 }).factor === 1.65,
    "маршрут ушёл водителю в Telegram, рейс «отправлен»": sent.status === "sent" && Boolean(route?.text.includes("ул. Шевченко 1") && route.text.includes("Звонить за 10 минут") && route.text.includes("maps.example")) && afterSend.status === "sent",
    "прогноз: снег + пробки → задержка, получателям и команде": told === 2 && Boolean(annaDelay?.text.includes("снег")) && Boolean(borisDelay) && Boolean(teamDelay) && afterTick.risk.includes("снег") && meteoCalls >= 1,
    "повторно за 15 минут не пишем": again === 0,
    "водитель: маршрут и отметка через агента; чужому — нет маршрута": list.includes("1.") && list.includes("Анна") && r1.includes("Next: Борис") && stranger.includes("no active route"),
    "получателю «доставлено», следующему «едет к вам»": Boolean(annaDone) && Boolean(borisOnWay),
    "«где мой заказ»: в пути, ожидаемое время": borisAsks.startsWith("On the way") && borisAsks.includes("Expected"),
    "все точки отмечены — рейс завершён, команде — итог": r2.includes("finished") && final.status === "done" && Boolean(finished),
    "сводка: доставлено, не доставлено, вовремя": stats.trips === 1 && stats.done === 1 && stats.failed === 1 && stats.onTimePct !== null,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
