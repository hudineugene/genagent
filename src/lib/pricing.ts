import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientPricing, dataTables, type ClientPricing, type DataTable } from "@/db/schema";
import { refreshTable, toNumber } from "@/lib/data/tables";
import type { AgentTool } from "@/lib/llm";

/**
 * Расчёт коммерческого предложения по правилам клиента: цена позиции — из прайса (таблица «Данных»), строка —
 * цена × количество, скидка — по ступеням суммы или количества, НДС, итог. Всё считает код; позиции, которых нет
 * в прайсе, не оцениваются, а перечисляются отдельно.
 */
export type QuoteItem = { name: string; qty: number };
export type QuoteLine = { name: string; qty: number; price: number; total: number };
export type Quote = { lines: QuoteLine[]; unknown: string[]; subtotal: number; discountPercent: number; discount: number; net: number; vat: number; vatPercent: number; total: number; currency: string };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Найти строку прайса: точное совпадение, затем «содержит», затем наибольшее совпадение слов. */
function findRow(rows: string[][], col: number, name: string): string[] | null {
  const n = norm(name);
  if (!n) return null;
  const exact = rows.find((r) => norm(r[col] ?? "") === n);
  if (exact) return exact;
  const contains = rows.filter((r) => {
    const v = norm(r[col] ?? "");
    return v && (v.includes(n) || n.includes(v));
  });
  if (contains.length === 1) return contains[0];
  const words = new Set(n.split(" ").filter((w) => w.length > 2));
  let best: { row: string[]; score: number } | null = null;
  for (const r of contains.length ? contains : rows) {
    const vw = norm(r[col] ?? "").split(" ").filter((w) => w.length > 2);
    const score = vw.filter((w) => words.has(w)).length / Math.max(vw.length, words.size, 1);
    if (score >= 0.5 && (!best || score > best.score)) best = { row: r, score };
  }
  return best?.row ?? null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function calcQuote(p: Pick<ClientPricing, "nameColumn" | "priceColumn" | "tierBy" | "tiers" | "vat" | "currency">, t: Pick<DataTable, "columns" | "rows">, items: QuoteItem[]): Quote {
  const nameCol = t.columns.findIndex((c) => c.name === p.nameColumn);
  const priceCol = t.columns.findIndex((c) => c.name === p.priceColumn);
  if (nameCol < 0 || priceCol < 0) throw new Error("columns");
  const lines: QuoteLine[] = [];
  const unknown: string[] = [];
  for (const it of items) {
    const row = findRow(t.rows, nameCol, it.name);
    const price = row ? toNumber(row[priceCol]) : null;
    if (!row || price == null) {
      unknown.push(it.name);
      continue;
    }
    const qty = Math.max(0, it.qty);
    lines.push({ name: row[nameCol], qty, price, total: round2(price * qty) });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.total, 0));
  const measure = p.tierBy === "qty" ? lines.reduce((s, l) => s + l.qty, 0) : subtotal;
  const tier = [...p.tiers].sort((a, b) => b.from - a.from).find((x) => measure >= x.from);
  const discountPercent = tier?.percent ?? 0;
  const discount = round2((subtotal * discountPercent) / 100);
  const net = round2(subtotal - discount);
  const vat = round2((net * p.vat) / 100);
  return { lines, unknown, subtotal, discountPercent, discount, net, vat, vatPercent: p.vat, total: round2(net + vat), currency: p.currency };
}

export function formatQuote(q: Quote, notes = "") {
  const money = (n: number) => `${n.toLocaleString("ru-RU", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} ${q.currency}`;
  return [
    ...q.lines.map((l) => `${l.name} — ${l.qty} × ${money(l.price)} = ${money(l.total)}`),
    `Сумма: ${money(q.subtotal)}`,
    q.discountPercent ? `Скидка ${q.discountPercent}%: −${money(q.discount)}` : "",
    q.vatPercent ? `НДС ${q.vatPercent}%: ${money(q.vat)}` : "",
    `Итого: ${money(q.total)}`,
    q.unknown.length ? `Нет в прайсе (не посчитано): ${q.unknown.join(", ")}` : "",
    notes ? `Условия: ${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getPricing(clientId: string) {
  const [p] = await db.select().from(clientPricing).where(eq(clientPricing.clientId, clientId));
  if (!p?.tableId) return null;
  const [t] = await db.select().from(dataTables).where(eq(dataTables.id, p.tableId));
  return t ? { pricing: p, table: t } : null;
}

/** Инструмент агента: расчёт КП по прайсу и скидкам клиента. */
export function pricingTool(clientId: string): AgentTool {
  return {
    name: "calc_quote",
    description:
      "Calculate a commercial offer exactly by the company's price list, volume discounts and VAT. Pass items with names as the customer said them and quantities. Never calculate prices yourself — use this tool and quote its result; items not in the price list must not be priced.",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, qty: { type: "number" } }, required: ["name", "qty"] } } },
      required: ["items"],
    },
    parse: z.object({ items: z.array(z.object({ name: z.string().trim().min(1).max(200), qty: z.number().min(0).max(1_000_000) })).min(1).max(50) }),
    run: async (input) => {
      const found = await getPricing(clientId);
      if (!found) return "Price list is not configured — say the manager will prepare the offer.";
      const table = await refreshTable(found.table);
      const q = calcQuote(found.pricing, table, (input as { items: QuoteItem[] }).items);
      return formatQuote(q, found.pricing.notes);
    },
  };
}
