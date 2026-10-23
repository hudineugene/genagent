/** Свои инструменты агента: агент сам вызывает внешнюю систему (макет CRM), параметры подставляются в адрес,
 *  ключ уходит в заголовке; в тестовом режиме меняющий запрос не отправляется; внутренние адреса запрещены;
 *  хост нельзя подменить параметром. Модель — заглушка. DB_PATH=<копия caltest> npx tsx scripts/test-custom-tools.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clientTools, clients } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const crm: { method: string; url: string; auth?: string; body: string }[] = [];
  const toolResults: string[] = [];
  let nextCall: { name: string; input: object } | null = null;

  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/crm/")) {
        crm.push({ method: req.method ?? "", url: req.url, auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ order: "A-17", status: "в пути", eta: "завтра" }));
        return;
      }
      const b = JSON.parse(body);
      const last = b.messages.at(-1);
      const result = Array.isArray(last?.content) ? last.content.find((c: { type: string }) => c.type === "tool_result") : null;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      if (result || !nextCall) {
        if (result) toolResults.push(typeof result.content === "string" ? result.content : JSON.stringify(result.content));
        res.end(
          start +
            ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Готово." } }) +
            ev("content_block_stop", { index: 0 }) +
            ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
            ev("message_stop", {}),
        );
        return;
      }
      const call = nextCall;
      res.end(
        start +
          ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_1", name: call.name, input: {} } }) +
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4043, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4043";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const [get] = await db
    .insert(clientTools)
    .values({
      clientId: client.id,
      name: "order_status",
      title: "Статус заказа",
      description: "Узнать статус заказа по номеру",
      method: "GET",
      url: "http://127.0.0.1:4043/crm/orders/{order_id}",
      headers: { Authorization: "Bearer secret-123" },
      params: [
        { name: "order_id", type: "string", description: "номер заказа", required: true },
        { name: "lang", type: "string", description: "язык", required: false },
      ],
      readOnly: true,
    })
    .returning();
  const [post] = await db
    .insert(clientTools)
    .values({
      clientId: client.id,
      name: "add_note",
      title: "Заметка в CRM",
      description: "Добавить заметку",
      method: "POST",
      url: "http://127.0.0.1:4043/crm/notes",
      params: [{ name: "text", type: "string", description: "текст", required: true }],
      readOnly: false,
    })
    .returning();

  const { prepareChat } = await import("@/lib/agent/runtime");
  const { streamChat } = await import("@/lib/llm");
  const { callTool, buildRequest } = await import("@/lib/agent/custom-tools");
  const config = { ...agentConfigSchema.parse(agent.config), toolIds: [get.id, post.id], calendar: { ...agentConfigSchema.parse(agent.config).calendar, enabled: false } };
  const run = async (mode: "live" | "dry", call: { name: string; input: object }) => {
    nextCall = call;
    const p = await prepareChat(config, client, [{ role: "user", content: "Где мой заказ A-17?" }], { mode, agentId: agent.id });
    const events = [];
    for await (const e of streamChat({ model: "anthropic:claude-haiku-5-5", effort: "low", system: p.system, messages: p.messages, tools: p.tools })) events.push(e);
    return { tools: p.tools?.map((t) => t.name) ?? [], events };
  };

  process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS = "1";
  const live = await run("live", { name: "order_status", input: { order_id: "A-17", lang: "ru" } });
  const afterLive = crm.length;
  const dry = await run("dry", { name: "add_note", input: { text: "перезвонить" } });
  const dryGet = await run("dry", { name: "order_status", input: { order_id: "B/2" } });
  delete process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS;

  let blocked = "";
  await callTool(get, { order_id: "1" }).catch((e) => (blocked = e.message));
  let hostSwap = "";
  try {
    buildRequest({ method: "GET", url: "https://{shop}.example.com/x", params: [] }, { shop: "evil.com/" });
  } catch (e) {
    hostSwap = (e as Error).message;
  }
  const lastUsed = (await db.select().from(clientTools).where(eq(clientTools.id, get.id)))[0];

  await db.delete(clientTools).where(eq(clientTools.id, get.id));
  await db.delete(clientTools).where(eq(clientTools.id, post.id));
  stub.close();

  const result: Record<string, boolean> = {
    "инструменты переданы агенту": live.tools.includes("order_status") && live.tools.includes("add_note"),
    "живой режим: GET с подставленным номером и ключом": afterLive === 1 && crm[0].method === "GET" && crm[0].url === "/crm/orders/A-17?lang=ru" && crm[0].auth === "Bearer secret-123",
    "ответ системы ушёл агенту": toolResults[0]?.includes("HTTP 200") && toolResults[0]?.includes("в пути"),
    "тест-режим: меняющий запрос не отправлен": crm.length === 2 && toolResults[1]?.includes("Тестовый режим") && toolResults[1]?.includes("перезвонить"),
    "тест-режим: чтение выполняется, спецсимволы экранированы": crm[1]?.url === "/crm/orders/B%2F2",
    "внутренний адрес запрещён": blocked === "private_address",
    "хост не подменить параметром": hostSwap === "bad_url",
    "отмечен последний вызов": lastUsed.lastStatus === "200" && Boolean(lastUsed.lastUsedAt),
    "агент закончил ответом": live.events.some((e) => e.type === "text") && dry.events.some((e) => e.type === "text") && dryGet.events.length > 0,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
