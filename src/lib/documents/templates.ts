import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, docTemplates, generatedDocs, type DocTemplate } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import { publicUrl } from "@/lib/settings";
import type { ToolContext } from "@/lib/agent/tools";
import { studioTz } from "@/lib/general";

/**
 * Документы по шаблону: агент заполняет поля шаблона из разговора, документ сохраняется и получает ссылку
 * (/d/<id> — страница для печати и сохранения в PDF). В тест-чате и автотестах документ не выдаётся.
 */
export const docToolName = (t: Pick<DocTemplate, "id">) => `doc_${t.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;

/** Подставить поля: {{key}} → значение; незаполненные — «____». */
export function fillTemplate(body: string, values: Record<string, string>) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => values[k]?.trim() || "____");
}

export async function loadDocTemplates(clientId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(docTemplates).where(and(eq(docTemplates.clientId, clientId), inArray(docTemplates.id, ids), eq(docTemplates.enabled, true)));
}

/** Выдать документ: номер по порядку, дата, имя клиента + поля от агента. Возвращает ссылку. */
export async function issueDocument(t: DocTemplate, values: Record<string, string>, ctx: { conversationId?: string }) {
  const [{ counter }] = await db
    .update(docTemplates)
    .set({ counter: sql`${docTemplates.counter} + 1` })
    .where(eq(docTemplates.id, t.id))
    .returning({ counter: docTemplates.counter });
  const [conv] = ctx.conversationId ? await db.select({ name: conversations.contactName }).from(conversations).where(eq(conversations.id, ctx.conversationId)) : [];
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone: studioTz(), dateStyle: "long" }).format(new Date());
  const all = { date, number: String(counter), client: conv?.name ?? "", ...values };
  const id = randomBytes(12).toString("base64url");
  await db.insert(generatedDocs).values({ id, templateId: t.id, clientId: t.clientId, conversationId: ctx.conversationId ?? null, title: `${t.name} № ${counter}`, body: fillTemplate(t.body, all) });
  const base = publicUrl();
  return { id, url: base ? `${base}/d/${id}` : `/d/${id}` };
}

export function docTool(t: DocTemplate, ctx: ToolContext): AgentTool {
  const props = Object.fromEntries(t.fields.map((f) => [f.key, { type: "string", description: f.label }]));
  return {
    name: docToolName(t),
    description: `Document «${t.name}». When to use: ${t.purpose || "when the customer needs this document"}. Fill the fields from the conversation and the knowledge base (never invent prices or terms). The tool returns a link — send it to the customer.`.slice(0, 1500),
    inputSchema: { type: "object", properties: props, required: [] },
    parse: z.object(Object.fromEntries(t.fields.map((f) => [f.key, z.string().max(4000).optional()]))).passthrough(),
    run: async (input) => {
      const values = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)]));
      if (ctx.mode !== "live") return `[Test mode: document not issued. It would be «${t.name}» filled with: ${JSON.stringify(values)}]`;
      const doc = await issueDocument(t, values, { conversationId: ctx.conversationId });
      return `Document ready: ${doc.url} — send this link to the customer (they can open, print or save it as PDF).`;
    },
  };
}

/** Подсказка агенту: какие документы он может выдать. */
export function docsNote(list: DocTemplate[]) {
  if (!list.length) return "";
  return [
    "# Документы для клиента",
    "Ты можешь выдать клиенту документ по шаблону (инструменты doc_…): заполни поля из разговора и базы знаний и отправь клиенту ссылку из ответа инструмента. Не выдумывай цены и условия, которых нет в базе знаний.",
    ...list.map((t) => `• «${t.name}» (${docToolName(t)}): ${t.purpose || "—"}`),
  ].join("\n");
}
