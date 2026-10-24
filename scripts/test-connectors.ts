/** Готовые подключения: MCP-сервер (инициализация, сессия, список инструментов, вызов с ответом потоком; в тест-чате
 *  меняющие инструменты не вызываются), KeyCRM (клиент, заказ, заявка), Bitrix24 (лид через вебхук), Shopify (статус
 *  заказа); заявка из диалога при передаче менеджеру уходит в CRM один раз. Все системы — заглушка.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-connectors.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientTools, clients, conversations } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS = "1";
  const calls: { path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }[] = [];
  const stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: url, body, headers: req.headers });
      const json = (o: object, h: Record<string, string> = {}) => {
        res.writeHead(200, { "content-type": "application/json", ...h });
        res.end(JSON.stringify(o));
      };
      if (url === "/mcp") {
        if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub" } } }, { "mcp-session-id": "sess-1" });
        if (body.method === "notifications/initialized") return void res.writeHead(202).end();
        if (body.method === "tools/list")
          return json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                { name: "get_stock", description: "Stock by SKU", inputSchema: { type: "object", properties: { sku: { type: "string" } } }, annotations: { readOnlyHint: true } },
                { name: "reserve.item", description: "Reserve an item", inputSchema: { type: "object", properties: { sku: { type: "string" } } } },
              ],
            },
          });
        if (body.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `stock ${(body.params as { arguments: { sku: string } }).arguments.sku}: 7` }] } })}\n\n`);
        }
      }
      if (url.startsWith("/keycrm/buyer")) return json({ data: [{ full_name: "Олена", phone: ["+380501112233"], orders_count: 3, orders_sum: 4200 }] });
      if (url.startsWith("/keycrm/order/77")) return json({ id: 77, status: { name: "Відправлено" }, grand_total: 1200, shipping: { tracking_code: "NP123" } });
      if (url === "/keycrm/pipelines/cards") return json({ id: 501 });
      if (url === "/rest/1/abc/crm.lead.add.json") return json({ result: 9001 });
      if (url.startsWith("/admin/api/2025-07/orders.json")) return json({ orders: [{ name: "#1001", financial_status: "paid", fulfillment_status: "fulfilled", total_price: "99.00", currency: "EUR", fulfillments: [{ tracking_number: "TR1" }] }] });
      json({});
    });
  });
  await new Promise<void>((r) => stub.listen(4081, r));
  process.env.KEYCRM_URL = "http://127.0.0.1:4081/keycrm";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Connectors Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "conn-agent" }).returning();
  const [mcp] = await db.insert(clientTools).values({ clientId: c.id, kind: "mcp", name: "stock", title: "Склад", url: "http://127.0.0.1:4081/mcp", headers: { authorization: "Bearer t0k" } }).returning();
  const [kc] = await db.insert(clientTools).values({ clientId: c.id, kind: "crm", name: "crm", title: "KeyCRM", url: "", config: { provider: "keycrm", key: "kc-key", pushLeads: true } }).returning();
  const [bx] = await db.insert(clientTools).values({ clientId: c.id, kind: "crm", name: "bx", title: "Bitrix24", url: "", config: { provider: "bitrix24", webhook: "http://127.0.0.1:4081/rest/1/abc", pushLeads: true } }).returning();
  const [sh] = await db.insert(clientTools).values({ clientId: c.id, kind: "crm", name: "shop", title: "Shopify", url: "", config: { provider: "shopify", domain: "127.0.0.1:4081", key: "shp" } }).returning();

  const { loadAgentTools } = await import("@/lib/agent/custom-tools");
  const live = await loadAgentTools(c.id, [mcp.id, kc.id, bx.id, sh.id], { mode: "live" });
  const dry = await loadAgentTools(c.id, [mcp.id], { mode: "dry" });
  const tool = (list: typeof live, n: string) => list.find((t) => t.name === n)!;
  const stock = await tool(live, "stock__get_stock").run({ sku: "A1" });
  const reserveDry = await tool(dry, "stock__reserve_item").run({ sku: "A1" });
  const mcpCalls = calls.filter((x) => x.path === "/mcp");
  const found = await tool(live, "crm_find_customer").run({ phone: "+38 (050) 111-22-33" });
  const order = await tool(live, "crm_order_status").run({ order: "#77" });
  const shopOrder = await tool(live, "shop_order_status").run({ order: "1001" });

  // Заявка из диалога: передача менеджеру → лид в KeyCRM и Bitrix24, повтор — без дублей
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: "conn-1", contactName: "Ірина", context: { lead: { temperature: "hot", reason: "", fields: [{ label: "Телефон", value: "+380671234567" }], at: 0 } } as never })
    .returning();
  const { pushLeadToCrm } = await import("@/lib/crm");
  const n1 = await pushLeadToCrm({ clientId: c.id, conversationId: conv.id, summary: "Хоче диван", reason: "покупка" });
  const n2 = await pushLeadToCrm({ clientId: c.id, conversationId: conv.id, summary: "Хоче диван" });
  const [after] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
  const card = calls.find((x) => x.path === "/keycrm/pipelines/cards");
  const bxLead = calls.find((x) => x.path === "/rest/1/abc/crm.lead.add.json");

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "MCP: инструменты сервера с префиксом подключения": live.some((t) => t.name === "stock__get_stock") && live.some((t) => t.name === "stock__reserve_item"),
    "MCP: сессия и токен передаются, ответ потоком прочитан": stock === "stock A1: 7" && mcpCalls.some((x) => x.body.method === "tools/call" && x.headers["mcp-session-id"] === "sess-1" && x.headers.authorization === "Bearer t0k"),
    "MCP: в тест-чате меняющий инструмент не вызывается": reserveDry.startsWith("[Тестовый режим") && !mcpCalls.some((x) => (x.body.params as { name?: string })?.name === "reserve.item"),
    "KeyCRM: клиент по телефону и заказ": String(found).includes("Олена") && calls.some((x) => x.path.includes("filter[buyer_phone]=380501112233") && x.headers.authorization === "Bearer kc-key") && String(order).includes("Відправлено") && String(order).includes("NP123"),
    "Shopify: статус заказа": String(shopOrder).includes("fulfilled") && String(shopOrder).includes("TR1") && calls.some((x) => x.path.startsWith("/admin/api") && x.headers["x-shopify-access-token"] === "shp"),
    "заявка из диалога — в обе CRM, один раз": n1 === 2 && n2 === 0 && Object.keys(after?.context?.crmLeads ?? {}).length === 2,
    "в заявке контакт и выжимка": (card?.body.contact as { phone?: string })?.phone === "+380671234567" && String(card?.body.manager_comment).includes("Хоче диван") && (bxLead?.body.fields as { NAME?: string })?.NAME === "Ірина",
    "магазин без создания заявок — без инструмента заявки": !live.some((t) => t.name === "shop_create_lead"),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
