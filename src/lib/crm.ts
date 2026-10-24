import "server-only";
import { z } from "zod";
import { readLimited, safeFetch, ToolCallError } from "@/lib/agent/custom-tools";
import type { AgentTool } from "@/lib/llm";

/**
 * Готовые подключения к CRM и магазинам: агент находит клиента по телефону или почте, узнаёт статус заказа и
 * создаёт заявку; заявки из диалогов (передача менеджеру, горячий клиент) могут уходить в CRM сами.
 * KeyCRM, Bitrix24 (входящий вебхук), HubSpot (private app), Shopify (Admin API), WooCommerce (REST API).
 */
export const CRM_PROVIDERS = ["keycrm", "bitrix24", "hubspot", "shopify", "woocommerce"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];
export type CrmConfig = { provider: CrmProvider; key?: string; secret?: string; domain?: string; webhook?: string; pushLeads?: boolean };
export type Lead = { name: string; phone?: string; email?: string; comment: string; source?: string };

const TIMEOUT_MS = 12_000;
const MAX = 4000;

/** Что умеет подключение. */
export const CAN: Record<CrmProvider, { find: boolean; order: boolean; lead: boolean }> = {
  keycrm: { find: true, order: true, lead: true },
  bitrix24: { find: true, order: true, lead: true },
  hubspot: { find: true, order: false, lead: true },
  shopify: { find: true, order: true, lead: false },
  woocommerce: { find: true, order: true, lead: false },
};

const scheme = () => (process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS === "1" ? "http" : "https");
const host = (d: string) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

function base(c: CrmConfig) {
  switch (c.provider) {
    case "keycrm":
      return (process.env.KEYCRM_URL ?? "https://openapi.keycrm.app/v1").replace(/\/$/, "");
    case "hubspot":
      return (process.env.HUBSPOT_URL ?? "https://api.hubapi.com").replace(/\/$/, "");
    case "bitrix24":
      return (c.webhook ?? "").replace(/\/$/, "");
    case "shopify":
      return `${scheme()}://${host(c.domain ?? "")}/admin/api/2025-07`;
    case "woocommerce":
      return `${scheme()}://${host(c.domain ?? "")}/wp-json/wc/v3`;
  }
}

function auth(c: CrmConfig): Record<string, string> {
  switch (c.provider) {
    case "keycrm":
    case "hubspot":
      return { authorization: `Bearer ${c.key ?? ""}` };
    case "shopify":
      return { "x-shopify-access-token": c.key ?? "" };
    case "woocommerce":
      return { authorization: `Basic ${Buffer.from(`${c.key ?? ""}:${c.secret ?? ""}`).toString("base64")}` };
    default:
      return {};
  }
}

async function req<T>(c: CrmConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`${base(c)}${path}`);
  if (url.protocol !== "https:" && process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS !== "1") throw new ToolCallError("bad_url");
  const res = await safeFetch(url, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...auth(c) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) void res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) throw new ToolCallError("crm_unauthorized");
  if (!res.ok) throw new ToolCallError(`crm_http_${res.status}`);
  try {
    return JSON.parse(await readLimited(res, 2_000_000)) as T;
  } catch {
    return {} as T;
  }
}

const digits = (s = "") => s.replace(/\D/g, "");
const short = (o: unknown) => {
  const s = JSON.stringify(o);
  return s.length > MAX ? `${s.slice(0, MAX)}…` : s;
};

/** Клиент в CRM по телефону или почте — коротко: имя, контакты, сумма заказов, последние заказы. */
export async function findCustomer(c: CrmConfig, q: { phone?: string; email?: string }): Promise<string> {
  const phone = digits(q.phone);
  const email = q.email?.trim().toLowerCase();
  if (!phone && !email) return "Pass a phone or an email.";
  switch (c.provider) {
    case "keycrm": {
      const f = phone ? `filter[buyer_phone]=${phone}` : `filter[buyer_email]=${encodeURIComponent(email!)}`;
      const r = await req<{ data?: { full_name?: string; phone?: string[]; email?: string[]; orders_sum?: number; orders_count?: number }[] }>(c, "GET", `/buyer?${f}&limit=3`);
      return r.data?.length ? short(r.data.map((b) => ({ name: b.full_name, phone: b.phone, email: b.email, orders: b.orders_count, sum: b.orders_sum }))) : "Customer not found.";
    }
    case "bitrix24": {
      const r = await req<{ result?: { ID: string; NAME?: string; LAST_NAME?: string; PHONE?: { VALUE: string }[]; EMAIL?: { VALUE: string }[] }[] }>(c, "POST", "/crm.contact.list.json", {
        filter: phone ? { PHONE: phone } : { EMAIL: email },
        select: ["ID", "NAME", "LAST_NAME", "PHONE", "EMAIL"],
      });
      return r.result?.length ? short(r.result.slice(0, 3).map((x) => ({ id: x.ID, name: [x.NAME, x.LAST_NAME].filter(Boolean).join(" "), phone: x.PHONE?.map((p) => p.VALUE), email: x.EMAIL?.map((p) => p.VALUE) }))) : "Customer not found.";
    }
    case "hubspot": {
      const r = await req<{ results?: { id: string; properties: Record<string, string> }[] }>(c, "POST", "/crm/v3/objects/contacts/search", {
        filterGroups: [{ filters: [phone ? { propertyName: "phone", operator: "CONTAINS_TOKEN", value: `*${phone.slice(-9)}` } : { propertyName: "email", operator: "EQ", value: email }] }],
        properties: ["firstname", "lastname", "email", "phone", "lifecyclestage"],
        limit: 3,
      });
      return r.results?.length ? short(r.results.map((x) => ({ id: x.id, ...x.properties }))) : "Customer not found.";
    }
    case "shopify": {
      const r = await req<{ customers?: { id: number; first_name?: string; last_name?: string; email?: string; phone?: string; orders_count?: number; total_spent?: string }[] }>(
        c,
        "GET",
        `/customers/search.json?query=${encodeURIComponent(phone ? `phone:*${phone.slice(-9)}` : `email:${email}`)}&limit=3`,
      );
      return r.customers?.length ? short(r.customers.map((x) => ({ name: [x.first_name, x.last_name].filter(Boolean).join(" "), email: x.email, phone: x.phone, orders: x.orders_count, spent: x.total_spent }))) : "Customer not found.";
    }
    case "woocommerce": {
      const r = await req<{ id: number; first_name?: string; last_name?: string; email?: string; billing?: { phone?: string } }[]>(c, "GET", `/customers?${email ? `email=${encodeURIComponent(email)}` : `search=${phone}`}&per_page=3`);
      return Array.isArray(r) && r.length ? short(r.map((x) => ({ id: x.id, name: [x.first_name, x.last_name].filter(Boolean).join(" "), email: x.email, phone: x.billing?.phone }))) : "Customer not found.";
    }
  }
}

/** Статус заказа по номеру. */
export async function orderStatus(c: CrmConfig, order: string): Promise<string> {
  const n = order.trim().replace(/^#/, "");
  if (!n) return "Pass the order number.";
  switch (c.provider) {
    case "keycrm": {
      const r = await req<{ id?: number; status?: { name?: string }; grand_total?: number; ordered_at?: string; shipping?: { tracking_code?: string } }>(c, "GET", `/order/${encodeURIComponent(n)}?include=status,shipping`);
      return r.id ? short({ order: r.id, status: r.status?.name, total: r.grand_total, date: r.ordered_at, tracking: r.shipping?.tracking_code }) : "Order not found.";
    }
    case "bitrix24": {
      const r = await req<{ result?: { ID: string; TITLE?: string; STAGE_ID?: string; OPPORTUNITY?: string; CURRENCY_ID?: string } }>(c, "POST", "/crm.deal.get.json", { id: n });
      return r.result ? short({ deal: r.result.ID, title: r.result.TITLE, stage: r.result.STAGE_ID, sum: `${r.result.OPPORTUNITY ?? ""} ${r.result.CURRENCY_ID ?? ""}`.trim() }) : "Order not found.";
    }
    case "shopify": {
      const r = await req<{ orders?: { name: string; financial_status?: string; fulfillment_status?: string | null; total_price?: string; currency?: string; created_at?: string; fulfillments?: { tracking_number?: string }[] }[] }>(
        c,
        "GET",
        `/orders.json?name=${encodeURIComponent(`#${n}`)}&status=any&limit=1`,
      );
      const o = r.orders?.[0];
      return o ? short({ order: o.name, paid: o.financial_status, shipped: o.fulfillment_status ?? "unfulfilled", total: `${o.total_price} ${o.currency}`, date: o.created_at, tracking: o.fulfillments?.[0]?.tracking_number }) : "Order not found.";
    }
    case "woocommerce": {
      const r = await req<{ id?: number; status?: string; total?: string; currency?: string; date_created?: string }>(c, "GET", `/orders/${encodeURIComponent(n)}`);
      return r.id ? short({ order: r.id, status: r.status, total: `${r.total} ${r.currency}`, date: r.date_created }) : "Order not found.";
    }
    default:
      return "Order lookup is not available for this system.";
  }
}

/** Новая заявка (лид, карточка воронки, контакт с заметкой). Возвращает id в CRM. */
export async function createLead(c: CrmConfig, lead: Lead): Promise<string> {
  const phone = lead.phone ? `+${digits(lead.phone)}` : undefined;
  const title = `${lead.source ?? "GenAgent"}: ${lead.name || phone || lead.email || "клиент"}`.slice(0, 200);
  switch (c.provider) {
    case "keycrm": {
      const r = await req<{ id?: number }>(c, "POST", "/pipelines/cards", { title, manager_comment: lead.comment.slice(0, 4000), contact: { full_name: lead.name, phone, email: lead.email } });
      return String(r.id ?? "");
    }
    case "bitrix24": {
      const r = await req<{ result?: number }>(c, "POST", "/crm.lead.add.json", {
        fields: { TITLE: title, NAME: lead.name, COMMENTS: lead.comment.slice(0, 4000), SOURCE_ID: "WEB", ...(phone ? { PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }] } : {}), ...(lead.email ? { EMAIL: [{ VALUE: lead.email, VALUE_TYPE: "WORK" }] } : {}) },
      });
      return String(r.result ?? "");
    }
    case "hubspot": {
      const [firstname, ...rest] = (lead.name || "").split(" ");
      const r = await req<{ id?: string }>(c, "POST", "/crm/v3/objects/contacts", { properties: { firstname, lastname: rest.join(" "), phone, email: lead.email, hs_lead_status: "NEW" } });
      if (r.id) {
        await req(c, "POST", "/crm/v3/objects/notes", {
          properties: { hs_note_body: lead.comment.slice(0, 4000), hs_timestamp: new Date().toISOString() },
          associations: [{ to: { id: r.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
        }).catch(() => null);
      }
      return String(r.id ?? "");
    }
    default:
      throw new ToolCallError("lead_not_supported");
  }
}

/** Проверка подключения из админки: короткий запрос, который не меняет данные. */
export async function pingCrm(c: CrmConfig): Promise<void> {
  switch (c.provider) {
    case "keycrm":
      await req(c, "GET", "/order?limit=1");
      return;
    case "bitrix24":
      await req(c, "POST", "/crm.lead.fields.json", {});
      return;
    case "hubspot":
      await req(c, "GET", "/crm/v3/objects/contacts?limit=1");
      return;
    case "shopify":
      await req(c, "GET", "/shop.json");
      return;
    case "woocommerce":
      await req(c, "GET", "/system_status");
      return;
  }
}

/** Инструменты агента для подключения (имена с префиксом подключения). */
export function crmTools(prefix: string, title: string, c: CrmConfig, ctx: { mode: "live" | "dry" }): AgentTool[] {
  const can = CAN[c.provider];
  const fail = (e: unknown) => {
    throw new Error(`${title} is unavailable right now (${e instanceof Error ? e.message : String(e)}). Do not invent its data: tell the customer you will check with a manager.`);
  };
  const tools: AgentTool[] = [];
  if (can.find)
    tools.push({
      name: `${prefix}_find_customer`,
      description: `${title}: find the customer by phone or email — name, contacts, orders. Use to recognise a returning customer.`,
      inputSchema: { type: "object", properties: { phone: { type: "string" }, email: { type: "string" } } },
      parse: z.object({ phone: z.string().max(40).optional(), email: z.string().max(200).optional() }),
      run: (i) => findCustomer(c, i as { phone?: string; email?: string }).catch(fail),
    });
  if (can.order)
    tools.push({
      name: `${prefix}_order_status`,
      description: `${title}: status of an order by its number — paid, shipped, tracking. Use when the customer asks where the order is.`,
      inputSchema: { type: "object", properties: { order: { type: "string", description: "Order number" } }, required: ["order"] },
      parse: z.object({ order: z.string().min(1).max(40) }),
      run: (i) => orderStatus(c, (i as { order: string }).order).catch(fail),
    });
  if (can.lead)
    tools.push({
      name: `${prefix}_create_lead`,
      description: `${title}: create a lead for managers when the customer is ready (wants a call, an offer, to buy). Pass the contact and a short summary of what they want.`,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, phone: { type: "string" }, email: { type: "string" }, comment: { type: "string", description: "What the customer wants, budget, timing" } },
        required: ["comment"],
      },
      parse: z.object({ name: z.string().max(200).default(""), phone: z.string().max(40).optional(), email: z.string().max(200).optional(), comment: z.string().min(1).max(4000) }),
      run: async (i) => {
        if (ctx.mode === "dry") return `[Test chat: the lead is not created in ${title}. It would contain: ${JSON.stringify(i)}]`;
        const id = await createLead(c, i as Lead).catch(fail);
        return `Lead created in ${title}${id ? ` (id ${id})` : ""}.`;
      },
    });
  return tools;
}

/**
 * Заявка из диалога в CRM (передача менеджеру, «горячий» клиент): у подключений клиента с «передавать заявки» —
 * один лид на разговор (id запоминается в разговоре). Тестовые разговоры не отправляются.
 */
export async function pushLeadToCrm(input: { clientId: string; conversationId?: string | null; summary?: string; reason?: string }) {
  if (!input.conversationId) return 0;
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("@/db");
  const { clientTools, conversations } = await import("@/db/schema");
  const list = (await db.select().from(clientTools).where(and(eq(clientTools.clientId, input.clientId), eq(clientTools.kind, "crm"), eq(clientTools.enabled, true)))).filter(
    (t) => (t.config as CrmConfig).pushLeads && CAN[(t.config as CrmConfig).provider]?.lead,
  );
  if (!list.length) return 0;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, input.conversationId));
  if (!conv || conv.isTest || conv.context?.lead?.looksTest) return 0;
  const done = conv.context?.crmLeads ?? {};
  const lead = conv.context?.lead;
  const field = (re: RegExp) => lead?.fields.find((f) => re.test(f.label))?.value;
  const phone = field(/телефон|phone|контакт/i) ?? (/^\+?\d{9,15}$/.test(conv.externalId) ? conv.externalId : undefined);
  const email = field(/почт|email|e-mail/i);
  const comment = [
    input.summary,
    input.reason ? `Причина: ${input.reason}` : "",
    lead ? lead.fields.map((f) => `${f.label}: ${f.value}`).join("\n") : "",
    `Канал: ${conv.channelType}${conv.contactHandle ? ` ${conv.contactHandle}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  let n = 0;
  const ids: Record<string, string> = { ...done };
  for (const t of list) {
    if (done[t.id]) continue;
    try {
      const id = await createLead(t.config as CrmConfig, { name: conv.contactName || field(/имя|name/i) || "", phone: phone ?? undefined, email: email ?? undefined, comment, source: "GenAgent" });
      ids[t.id] = id || "ok";
      n++;
      await db.update(clientTools).set({ lastStatus: "lead: ok", lastUsedAt: new Date() }).where(eq(clientTools.id, t.id));
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      console.error("crm lead push failed", t.id, code);
      await db.update(clientTools).set({ lastStatus: `lead: ${code}`.slice(0, 120), lastUsedAt: new Date() }).where(eq(clientTools.id, t.id));
    }
  }
  if (n) {
    const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conv.id));
    await db.update(conversations).set({ context: { ...cur?.context, crmLeads: ids } }).where(eq(conversations.id, conv.id));
  }
  return n;
}
