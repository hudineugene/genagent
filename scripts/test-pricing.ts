/** Расчёт КП: позиции находятся в прайсе (точно, по вхождению, по словам), неизвестные не оцениваются, скидка —
 *  по ступени суммы или количества, НДС, итог; инструмент агента берёт прайс и правила клиента.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-pricing.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clientPricing, clients, dataTables } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { calcQuote, formatQuote, pricingTool } = await import("@/lib/pricing");
  const { buildTable } = await import("@/lib/data/tables");
  const t = buildTable([
    ["Позиция", "Цена, €"],
    ["Кухня премиум", "4 500"],
    ["Шкаф-купе 2 м", "1 200,50"],
    ["Монтаж", "300"],
  ]);
  const rules = { nameColumn: "Позиция", priceColumn: "Цена, €", tierBy: "amount" as const, tiers: [{ from: 5000, percent: 5 }, { from: 10000, percent: 10 }], vat: 21, currency: "€" };
  const q1 = calcQuote(rules, t, [{ name: "кухня премиум", qty: 2 }, { name: "шкаф", qty: 1 }, { name: "Монтаж кухни", qty: 3 }, { name: "Яхта", qty: 1 }]);
  const q2 = calcQuote({ ...rules, tierBy: "qty", tiers: [{ from: 5, percent: 3 }], vat: 0 }, t, [{ name: "Монтаж", qty: 6 }]);
  const text = formatQuote(q1, "Действует 14 дней").replace(/[  ]/g, " ");

  const [c] = await db.insert(clients).values({ name: "Pricing Test" }).returning();
  const [tbl] = await db.insert(dataTables).values({ clientId: c.id, name: "Прайс", columns: t.columns, rows: t.rows, rowCount: t.rows.length, refreshedAt: new Date() }).returning();
  const none = await pricingTool(c.id).run({ items: [{ name: "Монтаж", qty: 1 }] });
  await db.insert(clientPricing).values({ clientId: c.id, tableId: tbl.id, ...rules, notes: "Предоплата 30%" });
  const viaTool = (await pricingTool(c.id).run({ items: [{ name: "Монтаж", qty: 2 }] })).replace(/[  ]/g, " ");
  await db.delete(clients).where(eq(clients.id, c.id));

  const result: Record<string, boolean> = {
    "позиции найдены: точно, по вхождению, по словам": q1.lines.map((l) => l.name).join("|") === "Кухня премиум|Шкаф-купе 2 м|Монтаж" && q1.lines[1].price === 1200.5,
    "неизвестная позиция не оценена": q1.unknown.join() === "Яхта",
    "сумма, скидка по ступени суммы, НДС, итог": q1.subtotal === 11100.5 && q1.discountPercent === 10 && q1.discount === 1110.05 && q1.net === 9990.45 && q1.vat === 2097.99 && q1.total === 12088.44,
    "скидка от количества, без НДС": q2.subtotal === 1800 && q2.discountPercent === 3 && q2.total === 1746,
    "текст расчёта: строки, скидка, НДС, итог, не посчитано, условия": text.includes("Кухня премиум — 2 × 4 500 € = 9 000 €") && text.includes("Скидка 10%") && text.includes("НДС 21%") && text.includes("Шкаф-купе 2 м — 1 × 1 200,50 € = 1 200,50 €") && text.includes("Итого: 12 088,44 €") && text.includes("Нет в прайсе (не посчитано): Яхта") && text.includes("Условия: Действует 14 дней"),
    "инструмент агента: без правил — честно, с правилами — расчёт": none.includes("not configured") && viaTool.includes("Монтаж — 2 × 300 € = 600 €") && viaTool.includes("Предоплата 30%"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
