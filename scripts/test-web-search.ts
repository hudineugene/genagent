/** Поиск в интернете: передаётся модели, только когда разрешён в «Внешних сервисах» И включён у агента; поиски
 *  отмечаются в ответе и входят в стоимость ($0.01 за поиск). Модель — заглушка. DB_PATH=<копия caltest> npx tsx scripts/test-web-search.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, settings } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { getSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sentTools: unknown[][] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      sentTools.push(b.tools ?? []);
      const search = (b.tools ?? []).some((t: { name: string }) => t.name === "web_search");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const blocks = search
        ? ev("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } }) +
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"курс евро"}' } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "По данным ЕЦБ, 1 € = 1,08 $." } }) +
          ev("content_block_stop", { index: 1 })
        : ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Без поиска." } }) +
          ev("content_block_stop", { index: 0 });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          blocks +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5, ...(search ? { server_tool_use: { web_search_requests: 2 } } : {}) } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4044, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4044";
  process.env.ANTHROPIC_API_KEY = "stub";

  const before = await getSetting("services");
  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const base = agentConfigSchema.parse(agent.config);
  const config = { ...base, model: "anthropic:claude-haiku-5-5", calendar: { ...base.calendar, enabled: false } };
  const { prepareChat } = await import("@/lib/agent/runtime");
  const { streamChat } = await import("@/lib/llm");
  const { saveServices } = await import("@/lib/services");
  const { computeCost } = await import("@/lib/usage");
  const ask = async (c: typeof config) => {
    const p = await prepareChat(c, client, [{ role: "user", content: "Какой сейчас курс евро?" }], { mode: "dry" });
    const events = [];
    for await (const e of streamChat({ model: c.model, effort: "low", system: p.system, messages: p.messages, tools: p.tools, webSearch: p.webSearch })) events.push(e);
    return { p, events };
  };

  await saveServices({ webSearch: { enabled: false, maxUses: 3 } });
  const off = await ask({ ...config, webSearch: true });
  await saveServices({ webSearch: { enabled: true, maxUses: 2 } });
  const agentOff = await ask({ ...config, webSearch: false });
  const on = await ask({ ...config, webSearch: true });

  if (before === undefined) await db.delete(settings).where(eq(settings.key, "services"));
  else await saveServices(before as never);
  stub.close();

  const searchTool = (tools: unknown[]) => tools.find((t) => (t as { name: string }).name === "web_search") as { type: string; max_uses: number } | undefined;
  const done = on.events.find((e) => e.type === "done");
  const usage = done && done.type === "done" ? done.usage : undefined;
  const result: Record<string, boolean> = {
    "выключено в сервисах — поиска нет": !searchTool(sentTools[0]) && !off.p.webSearch,
    "выключено у агента — поиска нет": !searchTool(sentTools[1]),
    "включено — поиск передан модели с лимитом": searchTool(sentTools[2])?.max_uses === 2 && searchTool(sentTools[2])?.type === "web_search_20250305",
    "в инструкции агента — правила поиска": on.p.system.includes("# Поиск в интернете") && !agentOff.p.system.includes("# Поиск в интернете"),
    "поиск отмечен в ответе": on.events.some((e) => e.type === "tool" && e.name === "web_search"),
    "поиски в стоимости": usage?.webSearches === 2 && (computeCost("anthropic:claude-haiku-5-5", usage) ?? 0) >= 0.02,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
