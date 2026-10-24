"use server";

import { refresh } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientTools } from "@/db/schema";
import { RESERVED_TOOL_NAMES, TOOL_NAME_RE, ToolCallError, callTool, searchSheetTool } from "@/lib/agent/custom-tools";
import { spreadsheetId } from "@/lib/google/sheets";

import { requireClientAnd, requireOwned } from "@/lib/access";
export type ToolResult = { error?: string; id?: string };

const paramSchema = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/i),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().trim().max(300),
  required: z.boolean(),
});

const toolSchema = z.object({
  kind: z.enum(["http", "sheet"]).default("http"),
  sheet: z.string().trim().max(100).default(""),
  title: z.string().trim().min(1).max(100),
  name: z.string().trim(),
  description: z.string().trim().max(1200),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().trim().max(1000),
  headers: z.string().max(4000),
  params: z.array(z.unknown()).max(20),
  readOnly: z.boolean(),
  enabled: z.boolean(),
});

/** «Имя: значение» по строкам → объект. null — строка без двоеточия. */
function parseHeaders(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(":");
    if (i <= 0) return null;
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z0-9-]+$/.test(k)) return null;
    out[k] = line.slice(i + 1).trim();
  }
  return out;
}

export async function saveTool(clientId: string, id: string | null, input: z.input<typeof toolSchema>): Promise<ToolResult> {
  await requireClientAnd(clientId, "tool", id);
  const parsed = toolSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (!TOOL_NAME_RE.test(d.name)) return { error: "name" };
  if (RESERVED_TOOL_NAMES.has(d.name)) return { error: "reserved" };
  // Поиск в Google Таблице: ссылка на таблицу и лист; параметр один — что искать
  if (d.kind === "sheet" && !spreadsheetId(d.url)) return { error: "sheet_bad_url" };
  if (d.kind === "http") try {
    const u = new URL(d.url.replace(/\{[a-z0-9_]+\}/gi, "x"));
    if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "url" };
  } catch {
    return { error: "url" };
  }
  const headers = d.kind === "sheet" ? {} : parseHeaders(d.headers);
  if (!headers) return { error: "headers" };
  const params = z.array(paramSchema).safeParse(d.kind === "sheet" ? [] : d.params);
  if (!params.success || new Set(params.data.map((p) => p.name)).size !== params.data.length) return { error: "params" };

  const [dup] = await db
    .select({ id: clientTools.id })
    .from(clientTools)
    .where(and(eq(clientTools.clientId, clientId), eq(clientTools.name, d.name), id ? ne(clientTools.id, id) : undefined));
  if (dup) return { error: "duplicate" };

  const values = {
    kind: d.kind,
    sheet: d.kind === "sheet" ? d.sheet || "Лист1" : null,
    title: d.title,
    name: d.name,
    description: d.description,
    method: d.kind === "sheet" ? ("GET" as const) : d.method,
    url: d.url,
    headers,
    params: params.data,
    readOnly: d.kind === "sheet" ? true : d.readOnly,
    enabled: d.enabled,
    updatedAt: new Date(),
  };
  if (id) {
    await db.update(clientTools).set(values).where(and(eq(clientTools.id, id), eq(clientTools.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(clientTools).values({ clientId, ...values }).returning({ id: clientTools.id });
  refresh();
  return { id: row.id };
}

export async function deleteTool(id: string) {
  await requireOwned("tool", id);
  await db.delete(clientTools).where(eq(clientTools.id, id));
  refresh();
}

/** Проверочный вызов из админки — настоящий запрос с введёнными значениями. */
export async function testTool(id: string, input: Record<string, string>): Promise<{ ok: boolean; text: string }> {
  await requireOwned("tool", id);
  const [tool] = await db.select().from(clientTools).where(eq(clientTools.id, id));
  if (!tool) return { ok: false, text: "not_found" };
  if (tool.kind === "sheet") {
    try {
      return { ok: true, text: await searchSheetTool(tool, input.query ?? "") };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      refresh();
    }
  }
  // Значения из формы — строки: приводим к типам параметров
  const typed: Record<string, unknown> = {};
  for (const p of tool.params) {
    const v = input[p.name];
    if (v === undefined || v === "") continue;
    typed[p.name] = p.type === "number" ? Number(v) : p.type === "boolean" ? v === "true" || v === "1" || v === "да" : v;
  }
  try {
    return { ok: true, text: await callTool(tool, typed) };
  } catch (e) {
    return { ok: false, text: e instanceof ToolCallError ? e.message : e instanceof Error ? e.message : String(e) };
  } finally {
    refresh();
  }
}
