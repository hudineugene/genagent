import "server-only";
import { assertPublicHost, readLimited, ToolCallError } from "./custom-tools";

/**
 * Клиент MCP (Model Context Protocol, транспорт Streamable HTTP): агент подключается к MCP-серверу клиента или
 * сервиса (CRM, склад, Notion, Zapier MCP…) и пользуется всеми его инструментами. Запросы JSON-RPC 2.0, ответ —
 * JSON или поток событий; сессия (Mcp-Session-Id) и список инструментов запоминаются на 10 минут.
 * Защита та же, что у своих инструментов: только внешние адреса, без перенаправлений, таймаут, ограничение ответа.
 */
export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };

const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 15_000;
const TTL_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 6000;

type Conn = { session?: string; tools?: McpTool[]; at: number };
const g = globalThis as unknown as { __mcp?: Map<string, Conn> };
const cache = (g.__mcp ??= new Map());

let seq = 0;

async function rpc(url: string, headers: Record<string, string>, method: string, params: unknown, session?: string, notify = false) {
  const u = new URL(url);
  await assertPublicHost(u.hostname);
  const res = await fetch(u, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      ...(session ? { "mcp-session-id": session } : {}),
      ...headers,
    },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++seq, method, params }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (notify) return { session: res.headers.get("mcp-session-id") ?? session, result: null };
  if (res.status === 401 || res.status === 403) throw new ToolCallError("mcp_unauthorized");
  if (!res.ok) throw new ToolCallError(`mcp_http_${res.status}`);
  const text = await readLimited(res, 400_000);
  const type = res.headers.get("content-type") ?? "";
  let msg: { result?: unknown; error?: { message?: string } } | undefined;
  if (type.includes("text/event-stream")) {
    // Поток: берём последнее сообщение-ответ
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const m = JSON.parse(line.slice(5).trim());
        if (m && ("result" in m || "error" in m)) msg = m;
      } catch {
        /* не JSON — пропускаем */
      }
    }
  } else {
    msg = JSON.parse(text || "{}");
  }
  if (!msg) throw new ToolCallError("mcp_no_response");
  if (msg.error) throw new ToolCallError(`mcp_error: ${(msg.error.message ?? "").slice(0, 120)}`);
  return { session: res.headers.get("mcp-session-id") ?? session, result: msg.result };
}

async function connect(key: string, url: string, headers: Record<string, string>, fresh = false): Promise<Conn> {
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit;
  const init = await rpc(url, headers, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "GenAgent", version: "1.0" } });
  await rpc(url, headers, "notifications/initialized", {}, init.session, true).catch(() => null);
  const conn: Conn = { session: init.session ?? undefined, at: Date.now() };
  cache.set(key, conn);
  return conn;
}

/** Инструменты MCP-сервера (до 40). */
export async function listMcpTools(key: string, url: string, headers: Record<string, string>, fresh = false): Promise<McpTool[]> {
  const conn = await connect(key, url, headers, fresh);
  if (conn.tools && !fresh) return conn.tools;
  const r = await rpc(url, headers, "tools/list", {}, conn.session);
  const tools = ((r.result as { tools?: McpTool[] })?.tools ?? []).slice(0, 40);
  conn.tools = tools;
  return tools;
}

/** Вызов инструмента: текст результата для агента (обрезанный). */
export async function callMcpTool(key: string, url: string, headers: Record<string, string>, name: string, args: Record<string, unknown>) {
  let conn = await connect(key, url, headers);
  let r;
  try {
    r = await rpc(url, headers, "tools/call", { name, arguments: args }, conn.session);
  } catch (e) {
    // Сессия устарела — переподключаемся один раз
    if (!(e instanceof ToolCallError) || !/mcp_http_(400|404)/.test(e.message)) throw e;
    conn = await connect(key, url, headers, true);
    r = await rpc(url, headers, "tools/call", { name, arguments: args }, conn.session);
  }
  const res = r.result as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const text = [
    ...(res?.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)),
    ...(res?.structuredContent && !(res.content ?? []).length ? [JSON.stringify(res.structuredContent)] : []),
  ].join("\n");
  const out = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(ответ обрезан)` : text;
  return res?.isError ? `ERROR: ${out}` : out;
}

/** Имя инструмента для модели: префикс подключения + имя на сервере (латиница, до 64 знаков). */
export function mcpToolName(prefix: string, name: string) {
  return `${prefix}__${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}
