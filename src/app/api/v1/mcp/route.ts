import { and, asc, desc, eq, gte, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients, conversations, knowledgeGaps, messages } from "@/db/schema";
import { authorize, iso, type ApiAuth } from "@/lib/public-api";

/**
 * MCP-сервер студии (Streamable HTTP, без сессий): Claude Desktop, Cursor и другие ассистенты подключают
 * https://…/api/v1/mcp с ключом API студии (Authorization: Bearer ga_live_…) и работают с данными программы:
 * клиенты, разговоры, вопросы без ответа, расходы; с ключом write — ответ клиенту от имени сотрудника.
 */
const PROTOCOL = "2025-06-18";

type Tool = { name: string; description: string; inputSchema: object; write?: boolean; readOnly?: boolean; run: (args: Record<string, unknown>, auth: ApiAuth) => Promise<unknown> };

const scopeWhere = (auth: ApiAuth, clientId?: unknown): SQL | undefined => {
  if (typeof clientId === "string" && clientId) return eq(conversations.clientId, clientId);
  return auth.key.clientIds ? inArray(conversations.clientId, auth.key.clientIds.length ? auth.key.clientIds : ["-"]) : undefined;
};

const TOOLS: Tool[] = [
  {
    name: "list_clients",
    description: "List the studio's clients (businesses) available to this key.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: async (_a, auth) => (await db.select({ id: clients.id, name: clients.name, industry: clients.industry }).from(clients).orderBy(asc(clients.name))).filter((c) => auth.can(c.id)),
  },
  {
    name: "list_conversations",
    description: "Recent customer conversations (newest first) with lead temperature and last message. Filter by client_id, status (open|closed), only_attention (waiting for a human).",
    inputSchema: { type: "object", properties: { client_id: { type: "string" }, status: { type: "string", enum: ["open", "closed"] }, only_attention: { type: "boolean" }, days: { type: "number", description: "Updated in the last N days (default 7)" }, limit: { type: "number" } } },
    readOnly: true,
    run: async (a, auth) => {
      if (typeof a.client_id === "string" && !auth.can(a.client_id)) throw new Error("client_not_allowed");
      const where: SQL[] = [eq(conversations.isTest, false), gte(conversations.lastMessageAt, new Date(Date.now() - Math.min(90, Number(a.days) || 7) * 86400_000))];
      const s = scopeWhere(auth, a.client_id);
      if (s) where.push(s);
      if (a.status === "open" || a.status === "closed") where.push(eq(conversations.status, a.status));
      if (a.only_attention) where.push(eq(conversations.needsAttention, true));
      const rows = await db.select().from(conversations).where(and(...where)).orderBy(desc(conversations.lastMessageAt)).limit(Math.min(100, Number(a.limit) || 30));
      return rows.map((c) => ({ id: c.id, client_id: c.clientId, channel: c.channelType, contact: c.contactName || c.contactHandle, status: c.status, needs_attention: c.needsAttention, lead: c.context?.lead?.temperature ?? null, last_message: c.lastMessageText, at: iso(c.lastMessageAt) }));
    },
  },
  {
    name: "get_conversation",
    description: "Full conversation: messages (customer, agent, manager), lead card and source.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    readOnly: true,
    run: async (a, auth) => {
      const [c] = await db.select().from(conversations).where(eq(conversations.id, String(a.id)));
      if (!c || !auth.can(c.clientId)) throw new Error("not_found");
      const msgs = await db.select().from(messages).where(and(eq(messages.conversationId, c.id), eq(messages.status, "sent"))).orderBy(asc(messages.createdAt)).limit(200);
      return {
        id: c.id,
        contact: c.contactName || c.contactHandle,
        lead: c.context?.lead ?? null,
        source: c.context?.source ?? null,
        messages: msgs.filter((m) => m.role !== "system").map((m) => ({ from: m.role === "user" ? "customer" : m.role === "assistant" ? "agent" : m.role, text: m.text, at: iso(m.createdAt) })),
      };
    },
  },
  {
    name: "unanswered_questions",
    description: "Questions customers asked that the agent could not answer (to add to the knowledge base).",
    inputSchema: { type: "object", properties: { client_id: { type: "string" } } },
    readOnly: true,
    run: async (a, auth) => {
      const rows = await db.select().from(knowledgeGaps).where(and(eq(knowledgeGaps.status, "open"), ...(typeof a.client_id === "string" ? [eq(knowledgeGaps.clientId, a.client_id)] : []))).orderBy(desc(knowledgeGaps.count)).limit(50);
      return rows.filter((g) => auth.can(g.clientId)).map((g) => ({ id: g.id, client_id: g.clientId, question: g.question, times: g.count }));
    },
  },
  {
    name: "usage",
    description: "AI and channel costs per client for a month (USD, cost price).",
    inputSchema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM, default current" } } },
    readOnly: true,
    run: async (a, auth) => {
      const { bills, currentMonth } = await import("@/lib/billing");
      const month = typeof a.month === "string" && /^\d{4}-\d{2}$/.test(a.month) ? a.month : currentMonth();
      return (await bills(month)).filter((b) => auth.can(b.clientId)).map((b) => ({ client: b.client, ai_usd: b.aiCost, channels_usd: b.channelCost }));
    },
  },
  {
    name: "send_message",
    description: "Send a message to the customer in a conversation as a studio manager (the agent stops replying there). Requires a write key.",
    inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, text: { type: "string" } }, required: ["conversation_id", "text"] },
    write: true,
    run: async (a, auth) => {
      const [c] = await db.select({ clientId: conversations.clientId }).from(conversations).where(eq(conversations.id, String(a.conversation_id)));
      if (!c || !auth.can(c.clientId)) throw new Error("not_found");
      const text = z.string().trim().min(1).max(4000).parse(a.text);
      const { operatorReplyCore } = await import("@/lib/operator");
      const r = await operatorReplyCore(String(a.conversation_id), text);
      if (r.error) throw new Error(r.error);
      return { ok: true };
    },
  },
];

const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const error = (id: unknown, code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });

export async function POST(req: Request) {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const msg = (await req.json().catch(() => null)) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null;
  if (!msg?.method) return error(null, -32600, "invalid_request");
  if (msg.id === undefined) return new Response(null, { status: 202 }); // уведомление
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "genagent-studio", version: "1.0" }, instructions: "GenAgent studio data: clients, customer conversations handled by AI agents, unanswered questions, costs." });
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, {
        tools: TOOLS.filter((t) => !t.write || auth.key.scope === "write").map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: Boolean(t.readOnly) } })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return error(msg.id, -32602, "unknown_tool");
      if (tool.write && auth.key.scope !== "write") return reply(msg.id, { content: [{ type: "text", text: "This key is read-only." }], isError: true });
      try {
        const out = await tool.run(msg.params?.arguments ?? {}, auth);
        return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(out, null, 1).slice(0, 60_000) }] });
      } catch (e) {
        return reply(msg.id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      return error(msg.id, -32601, "method_not_found");
  }
}

/** Поток событий сервер → клиент не нужен (без сессий). */
export function GET() {
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
}
