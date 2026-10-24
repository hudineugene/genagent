"use server";

import { refresh } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientTools } from "@/db/schema";
import { requireClientAnd, requireOwned } from "@/lib/access";
import { CRM_PROVIDERS, type CrmConfig } from "@/lib/crm";

const schema = z.object({
  kind: z.enum(["crm", "mcp"]),
  title: z.string().trim().min(1).max(100),
  name: z.string().trim().regex(/^[a-z][a-z0-9_]{1,24}$/),
  enabled: z.boolean(),
  // CRM
  provider: z.enum(CRM_PROVIDERS).optional(),
  key: z.string().trim().max(500).default(""),
  secret: z.string().trim().max(500).default(""),
  domain: z.string().trim().max(200).default(""),
  webhook: z.string().trim().max(500).default(""),
  pushLeads: z.boolean().default(false),
  // MCP
  url: z.string().trim().max(1000).default(""),
  token: z.string().trim().max(2000).default(""),
});
export type ConnectorInput = z.input<typeof schema>;

/** Готовое подключение (CRM или MCP-сервер). Пустые секретные поля — оставить прежние (в браузер они не отдаются). */
export async function saveConnector(clientId: string, id: string | null, input: ConnectorInput): Promise<{ error?: string; id?: string }> {
  await requireClientAnd(clientId, "tool", id);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const [cur] = id ? await db.select().from(clientTools).where(and(eq(clientTools.id, id), eq(clientTools.clientId, clientId))) : [];
  const [dup] = await db
    .select({ id: clientTools.id })
    .from(clientTools)
    .where(and(eq(clientTools.clientId, clientId), eq(clientTools.name, d.name), id ? ne(clientTools.id, id) : undefined));
  if (dup) return { error: "duplicate" };
  let values;
  if (d.kind === "crm") {
    if (!d.provider) return { error: "invalid" };
    const old = (cur?.kind === "crm" ? cur.config : {}) as CrmConfig;
    const same = old.provider === d.provider;
    const config: CrmConfig = {
      provider: d.provider,
      key: d.key || (same ? old.key : undefined),
      secret: d.secret || (same ? old.secret : undefined),
      domain: d.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || undefined,
      webhook: d.webhook || (same ? old.webhook : undefined),
      pushLeads: d.pushLeads,
    };
    if (d.provider === "bitrix24" && !/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/.test(config.webhook ?? "")) return { error: "webhook" };
    if ((d.provider === "shopify" || d.provider === "woocommerce") && !config.domain) return { error: "domain" };
    if (d.provider !== "bitrix24" && !config.key) return { error: "key" };
    values = { kind: "crm" as const, title: d.title, name: d.name, url: "", headers: {}, config, description: "", readOnly: false, enabled: d.enabled, updatedAt: new Date() };
  } else {
    try {
      const u = new URL(d.url);
      if (u.protocol !== "https:") return { error: "url" };
    } catch {
      return { error: "url" };
    }
    const oldAuth = cur?.kind === "mcp" ? cur.headers.authorization : undefined;
    const headers: Record<string, string> = d.token ? { authorization: d.token.startsWith("Bearer ") ? d.token : `Bearer ${d.token}` } : oldAuth ? { authorization: oldAuth } : {};
    values = { kind: "mcp" as const, title: d.title, name: d.name, url: d.url, headers, config: {}, description: "", readOnly: false, enabled: d.enabled, updatedAt: new Date() };
  }
  if (cur) {
    await db.update(clientTools).set(values).where(eq(clientTools.id, cur.id));
    refresh();
    return { id: cur.id };
  }
  const [row] = await db.insert(clientTools).values({ clientId, ...values }).returning({ id: clientTools.id });
  refresh();
  return { id: row.id };
}

/** Проверка подключения: CRM — запрос без изменений; MCP — список инструментов сервера. */
export async function testConnector(id: string): Promise<{ ok: boolean; text: string }> {
  await requireOwned("tool", id);
  const [t] = await db.select().from(clientTools).where(eq(clientTools.id, id));
  if (!t || (t.kind !== "crm" && t.kind !== "mcp")) return { ok: false, text: "not_found" };
  try {
    if (t.kind === "crm") {
      const { pingCrm } = await import("@/lib/crm");
      await pingCrm(t.config as unknown as CrmConfig);
      await db.update(clientTools).set({ lastStatus: "ok", lastUsedAt: new Date() }).where(eq(clientTools.id, id));
      return { ok: true, text: "ok" };
    }
    const { listMcpTools } = await import("@/lib/agent/mcp");
    const list = await listMcpTools(t.id, t.url, t.headers, true);
    await db.update(clientTools).set({ lastStatus: `ok: ${list.length}`, lastUsedAt: new Date() }).where(eq(clientTools.id, id));
    return { ok: true, text: list.map((x) => x.name).join(", ") || "—" };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    await db.update(clientTools).set({ lastStatus: text.slice(0, 120), lastUsedAt: new Date() }).where(eq(clientTools.id, id));
    return { ok: false, text };
  } finally {
    refresh();
  }
}
