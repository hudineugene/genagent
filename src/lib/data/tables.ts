import "server-only";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { dataTables, type DataColumn, type DataTable } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import { readXlsx } from "./xlsx";

/**
 * Таблицы данных: разбор CSV / Excel / Google Таблицы, типы столбцов и точный запрос (фильтры, группировки,
 * суммы, средние) на нашей стороне. Модель только формулирует запрос — числа считает код, а не она.
 */
export const MAX_ROWS = 20_000;
const MAX_COLS = 60;
/** Google Таблица перечитывается не чаще, чем раз в 10 минут */
const SHEET_TTL_MS = 10 * 60_000;

export const DATA_EXTENSIONS = [".csv", ".tsv", ".txt", ".xlsx"];

/** CSV с автоопределением разделителя (; , таб) и кавычками. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", "\t", ","].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > MAX_ROWS + 1) break;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Число из строки: «1 250,50 €», «$1,250.50», «12%», «-3.5». null — не число. */
export function toNumber(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v)
    .trim()
    .replace(/[\s  ']/g, "")
    .replace(/^([+-]?)[$€£₴₽¥]+/, "$1")
    .replace(/([$€£₴₽¥%]|грн\.?|руб\.?|eur|usd|uah)+$/i, "");
  if (!s || !/^[+-]?[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Последний разделитель — десятичный
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /^[+-]?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Дата → ГГГГ-ММ-ДД для сравнения: «23.10.2026», «2026-10-23», «23/10/2026». */
export function toIsoDate(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** Первая непустая строка — заголовок; пустые строки отбрасываются; типы столбцов — по 80% значений. */
export function buildTable(matrix: string[][]): { columns: DataColumn[]; rows: string[][] } {
  const clean = matrix.map((r) => r.map((c) => String(c ?? "").trim()));
  const headIdx = clean.findIndex((r) => r.some(Boolean));
  if (headIdx < 0) return { columns: [], rows: [] };
  const head = clean[headIdx].slice(0, MAX_COLS);
  while (head.length && !head.at(-1)) head.pop();
  const seen = new Map<string, number>();
  const names = head.map((h, i) => {
    const base = h || `Столбец ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows = clean
    .slice(headIdx + 1)
    .filter((r) => r.some(Boolean))
    .slice(0, MAX_ROWS)
    .map((r) => names.map((_, i) => r[i] ?? ""));
  const columns = names.map((name, i): DataColumn => {
    const values = rows.map((r) => r[i]).filter(Boolean);
    if (!values.length) return { name, type: "text" };
    const share = (f: (v: string) => unknown) => values.filter((v) => f(v) != null).length / values.length;
    if (share(toIsoDate) >= 0.8) return { name, type: "date" };
    if (share(toNumber) >= 0.8) return { name, type: "number" };
    return { name, type: "text" };
  });
  return { columns, rows };
}

/** Файл → матрица значений. */
export function readDataFile(buf: Buffer, filename: string, sheet?: string): string[][] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".xlsx") return readXlsx(buf, sheet, MAX_ROWS);
  if (DATA_EXTENSIONS.includes(ext)) return parseCsv(buf.toString("utf8"));
  throw new Error("unsupported");
}

/** Перечитать Google Таблицу (если источник — таблица и данные устарели). Ошибка — остаются прежние данные. */
export async function refreshTable(t: DataTable, force = false): Promise<DataTable> {
  if (t.source !== "sheet") return t;
  if (!force && t.refreshedAt && Date.now() - t.refreshedAt.getTime() < SHEET_TTL_MS) return t;
  const { spreadsheetId, readValues } = await import("@/lib/google/sheets");
  const id = spreadsheetId(t.sheetUrl);
  try {
    if (!id) throw new Error("Неверная ссылка на Google Таблицу");
    const { columns, rows } = buildTable(await readValues(id, t.sheetName, `A1:BH${MAX_ROWS + 1}`));
    const values = { columns, rows, rowCount: rows.length, refreshedAt: new Date(), error: null };
    await db.update(dataTables).set(values).where(eq(dataTables.id, t.id));
    return { ...t, ...values };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    await db.update(dataTables).set({ error, refreshedAt: new Date() }).where(eq(dataTables.id, t.id));
    return { ...t, error };
  }
}

export async function loadTables(clientId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(dataTables).where(and(eq(dataTables.clientId, clientId), inArray(dataTables.id, ids), eq(dataTables.enabled, true)));
}

// ——— Запрос ———

const OPS = ["=", "!=", ">", ">=", "<", "<=", "contains", "not_contains", "in", "empty", "not_empty"] as const;
const FNS = ["count", "sum", "avg", "min", "max", "count_distinct"] as const;

export const querySchema = z.object({
  filters: z
    .array(z.object({ column: z.string(), op: z.enum(OPS), value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional() }))
    .max(20)
    .optional(),
  groupBy: z.array(z.string()).max(4).optional(),
  metrics: z.array(z.object({ fn: z.enum(FNS), column: z.string().optional() })).max(8).optional(),
  columns: z.array(z.string()).max(20).optional(),
  sort: z.object({ by: z.string(), desc: z.boolean().optional() }).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type DataQuery = z.infer<typeof querySchema>;

const QUERY_JSON_SCHEMA = {
  type: "object",
  properties: {
    filters: {
      type: "array",
      description: "Row filters (AND). Dates as YYYY-MM-DD. contains — case-insensitive substring; in — list of values.",
      items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: [...OPS] }, value: {} }, required: ["column", "op"] },
    },
    groupBy: { type: "array", items: { type: "string" }, description: "Group rows by these columns" },
    metrics: {
      type: "array",
      description: "Aggregates (per group, or over all filtered rows). count needs no column.",
      items: { type: "object", properties: { fn: { type: "string", enum: [...FNS] }, column: { type: "string" } }, required: ["fn"] },
    },
    columns: { type: "array", items: { type: "string" }, description: "Columns to return when not aggregating (default: all)" },
    sort: { type: "object", properties: { by: { type: "string", description: "Column name or metric label like sum(Price)" }, desc: { type: "boolean" } }, required: ["by"] },
    limit: { type: "integer", description: "Max rows to return (default 30, max 200)" },
  },
};

export type QueryResult = { columns: string[]; rows: (string | number)[][]; matched: number };

const round = (n: number) => Math.round(n * 100) / 100;

export function runQuery(t: Pick<DataTable, "columns" | "rows">, q: DataQuery): QueryResult {
  const col = (name: string) => {
    const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.trim().toLowerCase());
    if (i < 0) throw new Error(`Unknown column «${name}». Columns: ${t.columns.map((c) => c.name).join(", ")}`);
    return i;
  };
  const cmp = (type: DataColumn["type"], a: string, b: string | number) => {
    if (type === "number") {
      const x = toNumber(a);
      const y = toNumber(b);
      if (x == null || y == null) return null;
      return x - y;
    }
    if (type === "date") {
      const x = toIsoDate(a);
      const y = toIsoDate(String(b));
      if (!x || !y) return null;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return a.toLowerCase().localeCompare(String(b).toLowerCase(), "ru");
  };
  const filters = (q.filters ?? []).map((f) => ({ ...f, i: col(f.column) }));
  const matched = t.rows.filter((r) =>
    filters.every((f) => {
      const v = r[f.i] ?? "";
      const type = t.columns[f.i].type;
      const val = f.value;
      switch (f.op) {
        case "empty":
          return !v;
        case "not_empty":
          return Boolean(v);
        case "contains":
          return v.toLowerCase().includes(String(val ?? "").toLowerCase());
        case "not_contains":
          return !v.toLowerCase().includes(String(val ?? "").toLowerCase());
        case "in": {
          const list = Array.isArray(val) ? val : String(val ?? "").split(",");
          return list.some((x) => cmp(type, v, typeof x === "number" ? x : x.trim()) === 0);
        }
        default: {
          if (Array.isArray(val) || val == null) return false;
          const c = cmp(type, v, val);
          if (c == null) return false;
          return f.op === "=" ? c === 0 : f.op === "!=" ? c !== 0 : f.op === ">" ? c > 0 : f.op === ">=" ? c >= 0 : f.op === "<" ? c < 0 : c <= 0;
        }
      }
    }),
  );

  let columns: string[];
  let rows: (string | number)[][];
  if (q.groupBy?.length || q.metrics?.length) {
    const keys = (q.groupBy ?? []).map(col);
    const metrics = (q.metrics?.length ? q.metrics : [{ fn: "count" as const }]).map((m) => ({ ...m, i: m.column ? col(m.column) : -1 }));
    const labels = metrics.map((m) => (m.i >= 0 ? `${m.fn}(${t.columns[m.i].name})` : m.fn));
    const groups = new Map<string, string[][]>();
    for (const r of matched) {
      const k = JSON.stringify(keys.map((i) => r[i] ?? ""));
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    if (!keys.length && !groups.size) groups.set("[]", []);
    columns = [...keys.map((i) => t.columns[i].name), ...labels];
    rows = [...groups].map(([k, rs]) => [
      ...(JSON.parse(k) as string[]),
      ...metrics.map((m) => {
        if (m.fn === "count") return m.i >= 0 ? rs.filter((r) => r[m.i]).length : rs.length;
        if (m.fn === "count_distinct") return new Set(rs.map((r) => r[m.i]).filter(Boolean)).size;
        const nums = rs.map((r) => toNumber(r[m.i])).filter((n): n is number => n != null);
        if (!nums.length) return "";
        if (m.fn === "sum") return round(nums.reduce((a, b) => a + b, 0));
        if (m.fn === "avg") return round(nums.reduce((a, b) => a + b, 0) / nums.length);
        if (m.fn === "min") return round(Math.min(...nums));
        return round(Math.max(...nums));
      }),
    ]);
  } else {
    const idx = q.columns?.length ? q.columns.map(col) : t.columns.map((_, i) => i).slice(0, 15);
    columns = idx.map((i) => t.columns[i].name);
    rows = matched.map((r) => idx.map((i) => r[i] ?? ""));
  }

  if (q.sort) {
    const si = columns.findIndex((c) => c.toLowerCase() === q.sort!.by.trim().toLowerCase());
    if (si < 0) throw new Error(`Unknown sort column «${q.sort.by}». Available: ${columns.join(", ")}`);
    const type = t.columns.find((c) => c.name === columns[si])?.type ?? "number";
    const dir = q.sort.desc ? -1 : 1;
    rows.sort((a, b) => {
      const x = a[si];
      const y = b[si];
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      const c = cmp(type, String(x), String(y));
      return (c ?? String(x).localeCompare(String(y), "ru")) * dir;
    });
  }
  return { columns, rows: rows.slice(0, q.limit ?? 30), matched: matched.length };
}

export function formatResult(r: QueryResult, totalRows?: number) {
  const lines = [r.columns.join(" | "), ...r.rows.map((x) => x.map((v) => String(v).replace(/\s+/g, " ").slice(0, 200)).join(" | "))];
  return `Matched rows: ${r.matched}${totalRows != null ? ` of ${totalRows}` : ""}. Returned: ${r.rows.length}.\n${lines.join("\n")}`;
}

export const tableToolName = (t: Pick<DataTable, "id">) => `table_${t.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;

/** Описание таблицы для модели: столбцы с типами и пара строк для примера значений. */
export function describeTable(t: Pick<DataTable, "name" | "description" | "columns" | "rows" | "rowCount">) {
  const sample = t.rows.slice(0, 2).map((r) => r.map((v) => v.slice(0, 40)).join(" | "));
  return [
    `Table «${t.name}»${t.description ? ` — ${t.description}` : ""}. Rows: ${t.rowCount}.`,
    `Columns: ${t.columns.map((c) => `${c.name} (${c.type})`).join("; ")}.`,
    sample.length ? `Sample rows:\n${sample.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function tableTool(t: DataTable, onResult?: (r: QueryResult) => void): AgentTool {
  return {
    name: tableToolName(t),
    description: `Query the data table exactly (filters, grouping, sum/avg/min/max/count) — never calculate numbers yourself, always use this tool.\n${describeTable(t)}`.slice(0, 3000),
    inputSchema: QUERY_JSON_SCHEMA,
    parse: querySchema,
    run: async (input) => {
      const fresh = await refreshTable(t);
      const r = runQuery(fresh, input as DataQuery);
      onResult?.(r);
      return formatResult(r, fresh.rowCount);
    },
  };
}

/** Подсказка агенту: какие таблицы у него есть. */
export function tablesNote(list: DataTable[]) {
  if (!list.length) return "";
  return [
    "# Таблицы данных",
    "У тебя есть таблицы данных (инструменты table_…). Любые числа, количества, суммы, средние и списки из них получай только через инструмент — не считай в уме и не выдумывай. Если данных нет в таблице — так и скажи.",
    ...list.map((t) => `• «${t.name}» (${tableToolName(t)}): ${t.description || "—"}`),
  ].join("\n");
}
