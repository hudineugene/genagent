/** MCP-сервер студии: без ключа — 401; initialize и tools/list (ключ чтения — без send_message); tools/call — клиенты
 *  и разговоры только доступные ключу, чужой разговор — ошибка; send_message ключом записи; клиент MCP студии
 *  (наш же) подключается к нему.  DB_PATH=<копия caltest> npx tsx scripts/test-mcp-server.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, apiKeys, channels, clients, conversations, messages } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { newApiKey } = await import("@/lib/public-api");
  const [a] = await db.insert(clients).values({ name: "MCP A" }).returning();
  const [b] = await db.insert(clients).values({ name: "MCP B" }).returning();
  const mk = async (clientId: string, ext: string) => {
    const [ag] = await db.insert(agents).values({ clientId, name: `mcp-${ext}`, config: agentConfigSchema.parse({ model: "anthropic:claude-haiku-5-5" }) }).returning();
    const [ch] = await db.insert(channels).values({ agentId: ag.id, clientId, type: "widget", name: "w", config: {} as never }).returning();
    const [conv] = await db.insert(conversations).values({ clientId, agentId: ag.id, channelId: ch.id, channelType: "widget", externalId: ext, contactName: `Клиент ${ext}` }).returning();
    await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Привет" } as never);
    return { ag, conv };
  };
  const A = await mk(a.id, "mcp-a");
  const B = await mk(b.id, "mcp-b");
  const key = async (scope: "read" | "write") => {
    const k = newApiKey();
    await db.insert(apiKeys).values({ name: "mcp", prefix: k.prefix, keyHash: k.hash, scope, clientIds: [a.id] });
    return k.key;
  };
  const read = await key("read");
  const write = await key("write");
  const { POST } = await import("@/app/api/v1/mcp/route");
  let id = 0;
  const rpc = async (k: string | null, method: string, params?: object) => {
    const res = await POST(new Request("https://x/api/v1/mcp", { method: "POST", headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }));
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  const call = async (k: string, name: string, args: object = {}) => (await rpc(k, "tools/call", { name, arguments: args })).body.result;
  const anon = await rpc(null, "initialize");
  const init = await rpc(read, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
  const listRead = await rpc(read, "tools/list");
  const listWrite = await rpc(write, "tools/list");
  const cl = JSON.parse((await call(read, "list_clients")).content[0].text);
  const convs = JSON.parse((await call(read, "list_conversations", { days: 30 })).content[0].text);
  const other = await call(read, "get_conversation", { id: B.conv.id });
  const sendRead = await call(read, "send_message", { conversation_id: A.conv.id, text: "Здравствуйте!" });
  const sendWrite = await call(write, "send_message", { conversation_id: A.conv.id, text: "Здравствуйте, это менеджер" });
  const sent = (await db.select().from(messages).where(eq(messages.conversationId, A.conv.id))).find((m) => m.role === "operator");

  await db.delete(apiKeys);
  for (const c of [a, b]) await db.delete(clients).where(eq(clients.id, c.id));
  for (const x of [A, B]) await db.delete(agents).where(eq(agents.id, x.ag.id));

  const names = (r: typeof listRead) => r.body.result.tools.map((t: { name: string }) => t.name);
  const r: Record<string, boolean> = {
    "без ключа — 401": anon.status === 401,
    "initialize: сервер и инструменты": init.body.result.serverInfo.name === "genagent-studio" && Boolean(init.body.result.capabilities.tools),
    "ключ чтения — без send_message, ключ записи — с ним": !names(listRead).includes("send_message") && names(listWrite).includes("send_message") && names(listRead).includes("get_conversation"),
    "только свои клиенты и разговоры": cl.length === 1 && cl[0].id === a.id && convs.every((c: { client_id: string }) => c.client_id === a.id) && convs.length >= 1,
    "чужой разговор — ошибка": other.isError === true,
    "запись: ключ чтения — отказ, ключ записи — сообщение от сотрудника": sendRead.isError === true && !sendWrite.isError && sent?.text === "Здравствуйте, это менеджер",
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
