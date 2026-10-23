/** Отправка данных во внешние системы: Google Таблица (шапка, строка заявки обновляется, передача — новой строкой),
 *  вебхук (подпись HMAC, повтор после сбоя), тестовые разговоры не уходят, внутренние адреса запрещены,
 *  поиск агентом в таблице. Google и вебхук — локальные макеты. DB_PATH=<копия caltest> npx tsx scripts/test-integrations.ts */
import http from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientIntegrations, clientTools, conversations, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { method: string; url: string; body: string }[] = [];
  const hooks: { body: string; sig?: string; event?: string }[] = [];
  let hookFails = 1;
  let header: string[][] = [];
  const table = [
    ["Товар", "Код", "Цена", "Наличие"],
    ["Нурофен 200 мг", "N200", "120 грн", "есть"],
    ["Нурофен форте", "N400", "180 грн", "нет"],
    ["Парацетамол", "P500", "40 грн", "есть"],
  ];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = decodeURIComponent(req.url ?? "");
      const json = (code: number, o: object) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url === "/token") return json(200, { access_token: "tok", expires_in: 3600 });
      if (url.startsWith("/hook")) {
        if (hookFails-- > 0) return json(500, {});
        hooks.push({ body, sig: req.headers["x-genagent-signature"] as string, event: req.headers["x-genagent-event"] as string });
        return json(200, {});
      }
      calls.push({ method: req.method ?? "", url, body });
      if (url.includes("PRICES")) return json(200, { values: table });
      if (req.method === "GET") return json(200, { values: header });
      if (req.method === "PUT" && url.includes("!A1?")) header = JSON.parse(body).values;
      if (url.includes(":append")) return json(200, { updates: { updatedRange: `'Лист1'!A${calls.filter((c) => c.url.includes(":append")).length + 1}:J` } });
      return json(200, {});
    });
  });
  await new Promise<void>((r) => stub.listen(4051, r));
  process.env.GOOGLE_TOKEN_URL = "http://127.0.0.1:4051/token";
  process.env.GOOGLE_SHEETS_URL = "http://127.0.0.1:4051/v4/spreadsheets";

  const google = await getSetting("google");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await setSetting("google", { clientEmail: "sa@test.iam", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

  const [agent] = await db.select().from(agents).limit(1);
  const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id)).limit(1);
  const mk = (isTest: boolean, ext: string) =>
    db
      .insert(conversations)
      .values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: ch.type, externalId: ext, contactName: "Ольга", contactHandle: "@olga", isTest })
      .returning()
      .then((r) => r[0]);
  const conv = await mk(false, "integ-1");
  const testConv = await mk(true, "integ-2");
  const SHEET = "https://docs.google.com/spreadsheets/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit";
  const [sheetInt] = await db
    .insert(clientIntegrations)
    .values({ clientId: agent.clientId, kind: "sheet", name: "Заявки", config: { url: SHEET, sheet: "Лист1" }, events: ["lead", "handoff"] })
    .returning();
  const [hookInt] = await db
    .insert(clientIntegrations)
    .values({ clientId: agent.clientId, kind: "webhook", name: "CRM", config: { url: "http://127.0.0.1:4051/hook", secret: "s3cret" }, events: ["handoff"] })
    .returning();

  const { emitEvent } = await import("@/lib/integrations/events");
  process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS = "1";
  const lead = (t: "warm" | "hot") => ({ temperature: t, reason: "ищет квартиру", fields: [{ label: "Бюджет", value: "200 000 €" }], at: Date.now(), upto: Date.now() });
  const n1 = await emitEvent("lead", { clientId: agent.clientId, agentId: agent.id, conversationId: conv.id, lead: lead("warm") });
  const appendsAfter1 = calls.filter((c) => c.url.includes(":append")).length;
  const row = (await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conv.id)))[0].context?.sheetRows?.[sheetInt.id];
  const n2 = await emitEvent("lead", { clientId: agent.clientId, agentId: agent.id, conversationId: conv.id, lead: lead("hot") });
  const appendsAfter2 = calls.filter((c) => c.url.includes(":append")).length;
  await db.update(conversations).set({ context: { ...(await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conv.id)))[0].context, lead: lead("hot") } }).where(eq(conversations.id, conv.id));
  const updated = calls.some((c) => c.method === "PUT" && c.url.includes(`!A${row}?`) && c.body.includes("горячий"));
  const n3 = await emitEvent("handoff", { clientId: agent.clientId, agentId: agent.id, conversationId: conv.id, summary: "Хочет просмотр в субботу" });
  const appendsAfter3 = calls.filter((c) => c.url.includes(":append")).length;
  const nTest = await emitEvent("handoff", { clientId: agent.clientId, agentId: agent.id, conversationId: testConv.id, summary: "тест" });
  delete process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS;
  const nPrivate = await emitEvent("handoff", { clientId: agent.clientId, agentId: agent.id, conversationId: conv.id, summary: "x" });
  const hookStatus = (await db.select().from(clientIntegrations).where(eq(clientIntegrations.id, hookInt.id)))[0].lastStatus;

  // Поиск агентом в таблице
  const [tool] = await db
    .insert(clientTools)
    .values({ clientId: agent.clientId, kind: "sheet", name: "prices", title: "Прайс", url: "https://docs.google.com/spreadsheets/d/PRICESPRICESPRICESPRICES/edit", sheet: "Цены" })
    .returning();
  const { searchSheetTool } = await import("@/lib/agent/custom-tools");
  const found = await searchSheetTool(tool, "нурофен форте");

  // уборка
  await db.delete(clientTools).where(eq(clientTools.id, tool.id));
  await db.delete(clientIntegrations).where(eq(clientIntegrations.id, sheetInt.id));
  await db.delete(clientIntegrations).where(eq(clientIntegrations.id, hookInt.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(conversations).where(eq(conversations.id, testConv.id));
  if (google === undefined) await db.delete(settings).where(eq(settings.key, "google"));
  else await setSetting("google", google);
  stub.close();

  const hook = hooks[0];
  const payload = hook ? JSON.parse(hook.body) : null;
  const result: Record<string, boolean> = {
    "таблица: шапка записана": header[0]?.[0] === "Дата" && header[0]?.includes("Данные клиента"),
    "заявка — новая строка, номер запомнен": n1 === 1 && appendsAfter1 === 1 && typeof row === "number",
    "обновлённая заявка — та же строка": n2 === 1 && updated && appendsAfter2 === 1,
    "передача — в таблицу и на вебхук": n3 === 2 && appendsAfter3 === 2,
    "вебхук: повтор после сбоя, подпись верна": hooks.length === 1 && hook.sig === `sha256=${createHmac("sha256", "s3cret").update(hook.body).digest("hex")}` && hook.event === "handoff",
    "вебхук: данные разговора и сводка": payload?.conversation?.contact === "Ольга" && payload?.summary === "Хочет просмотр в субботу" && payload?.lead?.fields?.["Бюджет"] === "200 000 €",
    "тестовый разговор не отправлен": nTest === 0,
    "внутренний адрес вебхука запрещён": nPrivate === 1 && Boolean(hookStatus?.includes("private_address")),
    "поиск в таблице: нужная строка": found.includes("Нурофен форте") && found.includes("180 грн") && !found.includes("Парацетамол"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
