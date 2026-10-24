import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientTools, type ClientTool, type ToolParam } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import type { ToolContext } from "./tools";

/**
 * Свои инструменты клиента: агент сам вызывает внешнюю систему по HTTP (CRM, склад, статус заказа, калькулятор…).
 * Инструмент описывают в админке: адрес с {параметрами}, метод, заголовки, параметры и когда его вызывать.
 * Защита: только внешние адреса (не localhost и не внутренняя сеть), без перенаправлений, таймаут, ограничение ответа;
 * параметры подставляются только в путь и запрос — хост не меняется. В тест-чате и автотестах запросы,
 * которые что-то меняют (не «только чтение»), не отправляются — агент получает пометку, что было бы отправлено.
 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const RESERVED_TOOL_NAMES = new Set(["find_free_slots", "book_appointment", "web_search"]);
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 200_000;
const MAX_RESULT_CHARS = 6000;

export class ToolCallError extends Error {}

/** Адрес из внутренней сети (localhost, частные диапазоны, link-local) — туда агент не ходит. */
export function isPrivateAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

export async function assertPublicHost(hostname: string) {
  // Только для автотестов на локальном макете системы; на сервере не задаётся
  if (process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS === "1") return;
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new ToolCallError("private_address");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new ToolCallError("dns_failed");
  });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new ToolCallError("private_address");
}

/** Готовый запрос: адрес с подставленными параметрами, тело. Хост берётся из шаблона и не меняется. */
export function buildRequest(tool: Pick<ClientTool, "method" | "url" | "params">, input: Record<string, unknown>) {
  const template = new URL(tool.url.replace(/\{[a-z0-9_]+\}/gi, "x"));
  if (template.protocol !== "https:" && template.protocol !== "http:") throw new ToolCallError("bad_url");
  const used = new Set<string>();
  const filled = tool.url.replace(/\{([a-z0-9_]+)\}/gi, (_m, name: string) => {
    used.add(name);
    return encodeURIComponent(String(input[name] ?? ""));
  });
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    throw new ToolCallError("bad_url");
  }
  if (url.host !== template.host) throw new ToolCallError("bad_url");
  const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => !used.has(k) && v !== undefined && v !== null && v !== ""));
  const withBody = tool.method !== "GET" && tool.method !== "DELETE";
  if (!withBody) for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));
  return { url, body: withBody ? JSON.stringify(rest) : undefined };
}

/** Выполнить вызов. Возвращает текст для агента: «HTTP 200» и тело ответа (обрезанное). */
export async function callTool(tool: ClientTool, input: Record<string, unknown>, opts: { dry?: boolean } = {}) {
  const { url, body } = buildRequest(tool, input);
  if (opts.dry && !tool.readOnly) {
    return `[Тестовый режим: запрос не отправлен, потому что он меняет данные. Было бы отправлено: ${tool.method} ${url.toString()}${body ? ` ${body}` : ""}. Считай, что вызов прошёл успешно.]`;
  }
  await assertPublicHost(url.hostname);
  let status = "error";
  try {
    const res = await fetch(url, {
      method: tool.method,
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5", ...(body ? { "content-type": "application/json" } : {}), ...tool.headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = String(res.status);
    const text = await readLimited(res);
    return `HTTP ${res.status}\n${text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(ответ обрезан)` : text}`;
  } catch (e) {
    status = e instanceof Error && e.name === "TimeoutError" ? "timeout" : `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    throw new ToolCallError(status);
  } finally {
    void db.update(clientTools).set({ lastStatus: status, lastUsedAt: new Date() }).where(eq(clientTools.id, tool.id)).catch(() => {});
  }
}

async function readLimited(res: Response) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES));
}

function inputSchema(params: ToolParam[]) {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type, description: p.description }])),
    required: params.filter((p) => p.required).map((p) => p.name),
  };
}

function zodSchema(params: ToolParam[]) {
  const base = { string: z.string().max(2000), number: z.number(), boolean: z.boolean() } as const;
  return z.object(Object.fromEntries(params.map((p) => [p.name, p.required ? base[p.type] : base[p.type].optional()]))).passthrough();
}

const SHEET_PARAMS: ToolParam[] = [{ name: "query", type: "string", description: "Words to find in the table rows (product, code, order number…)", required: true }];

/** Поиск в Google Таблице клиента: строки, где есть все слова запроса. */
export async function searchSheetTool(tool: Pick<ClientTool, "id" | "url" | "sheet">, query: string) {
  const { searchSheet, spreadsheetId } = await import("@/lib/google/sheets");
  const id = spreadsheetId(tool.url);
  if (!id) throw new ToolCallError("sheet_bad_url");
  let status = "error";
  try {
    const r = await searchSheet(id, tool.sheet || "Лист1", query);
    status = "200";
    if (!r.total) return `Nothing found for "${query}".`;
    return `Found ${r.total} row(s)${r.total > r.rows.length ? `, showing ${r.rows.length}` : ""}:\n${r.rows.map((x) => `- ${x}`).join("\n")}`;
  } catch (e) {
    status = e instanceof Error ? e.message : String(e);
    throw new ToolCallError(status);
  } finally {
    void db.update(clientTools).set({ lastStatus: status, lastUsedAt: new Date() }).where(eq(clientTools.id, tool.id)).catch(() => {});
  }
}

/** Инструмент для модели. Ошибка вызова — понятная агенту инструкция, а не падение ответа. */
export function toAgentTool(tool: ClientTool, ctx: Pick<ToolContext, "mode">): AgentTool {
  if (tool.kind === "sheet") {
    return {
      name: tool.name,
      description: `${tool.title}. ${tool.description} Search the company's table: pass the words to look for.`.slice(0, 1500),
      inputSchema: inputSchema(SHEET_PARAMS),
      parse: zodSchema(SHEET_PARAMS),
      run: async (input) => {
        try {
          return await searchSheetTool(tool, String((input as { query: string }).query));
        } catch (e) {
          const code = e instanceof Error ? e.message : String(e);
          throw new Error(`The table "${tool.title}" is unavailable right now (${code}). Do not invent its data: tell the customer you will check with a manager.`);
        }
      },
    };
  }
  return {
    name: tool.name,
    description: `${tool.title}. ${tool.description}`.slice(0, 1500),
    inputSchema: inputSchema(tool.params),
    parse: zodSchema(tool.params),
    run: async (input) => {
      try {
        return await callTool(tool, input as Record<string, unknown>, { dry: ctx.mode === "dry" });
      } catch (e) {
        const code = e instanceof Error ? e.message : String(e);
        throw new Error(`The external system "${tool.title}" is unavailable right now (${code}). Do not invent its data: tell the customer you will check with a manager.`);
      }
    },
  };
}

/** MCP-сервер: все его инструменты (имена с префиксом подключения); недоступен — без них, ответ не падает. */
async function mcpAgentTools(tool: ClientTool, ctx: Pick<ToolContext, "mode">): Promise<AgentTool[]> {
  const { callMcpTool, listMcpTools, mcpToolName } = await import("./mcp");
  let list;
  try {
    list = await listMcpTools(tool.id, tool.url, tool.headers);
    void db.update(clientTools).set({ lastStatus: `ok: ${list.length}`, lastUsedAt: new Date() }).where(eq(clientTools.id, tool.id)).catch(() => {});
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    console.error("mcp list failed", tool.id, code);
    void db.update(clientTools).set({ lastStatus: code.slice(0, 120), lastUsedAt: new Date() }).where(eq(clientTools.id, tool.id)).catch(() => {});
    return [];
  }
  return list.map((t) => {
    const readOnly = t.annotations?.readOnlyHint === true;
    return {
      name: mcpToolName(tool.name, t.name),
      description: `${tool.title}: ${t.description ?? t.name}`.slice(0, 1500),
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
      parse: z.record(z.string(), z.unknown()),
      run: async (input) => {
        if (ctx.mode === "dry" && !readOnly) return `[Тестовый режим: ${t.name} не вызван, потому что может менять данные. Аргументы: ${JSON.stringify(input).slice(0, 500)}. Считай, что вызов прошёл успешно.]`;
        try {
          return await callMcpTool(tool.id, tool.url, tool.headers, t.name, input as Record<string, unknown>);
        } catch (e) {
          const code = e instanceof Error ? e.message : String(e);
          throw new Error(`The external system "${tool.title}" is unavailable right now (${code}). Do not invent its data: tell the customer you will check with a manager.`);
        }
      },
    } satisfies AgentTool;
  });
}

/** Включённые инструменты агента. */
export async function loadAgentTools(clientId: string, ids: string[], ctx: Pick<ToolContext, "mode">): Promise<AgentTool[]> {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(clientTools)
    .where(and(eq(clientTools.clientId, clientId), inArray(clientTools.id, ids), eq(clientTools.enabled, true)));
  const out = await Promise.all(
    rows.map(async (r) => {
      if (r.kind === "mcp") return mcpAgentTools(r, ctx);
      if (r.kind === "crm") {
        const { crmTools } = await import("@/lib/crm");
        return crmTools(r.name, r.title, r.config as unknown as import("@/lib/crm").CrmConfig, ctx);
      }
      return [toAgentTool(r, ctx)];
    }),
  );
  return out.flat();
}
