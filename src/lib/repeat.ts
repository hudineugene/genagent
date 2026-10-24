import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clientRepeat, clients, dataTables, repeatNudges, type ClientRepeat, type DataTable } from "@/db/schema";
import { refreshTable, toIsoDate, toNumber } from "@/lib/data/tables";
import { generateJson } from "@/lib/llm/anthropic";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";
import { addDays, daysBetween, kyivNow, parseContact, reach } from "@/lib/reach";

/**
 * Прогноз повторных покупок по таблице заказов: для каждого клиента — сколько заказов, обычный интервал (медиана),
 * когда ждать следующую покупку и насколько это вероятно (чем ровнее интервалы и больше заказов — тем выше; сильно
 * просроченный — «уходит»). Тем, кому скоро покупать, — личное напоминание или предложение (раз на цикл покупки).
 */
const MODEL = "claude-haiku-5-5";
const PER_RUN = 50;

export type RepeatStatus = "due" | "late" | "lost" | "later";
export type RepeatCustomer = {
  customer: string;
  contact: string;
  orders: number;
  lastDate: string;
  interval: number;
  nextDate: string;
  daysLeft: number;
  probability: number;
  status: RepeatStatus;
  total: number | null;
  products: string[];
};

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function predictRepeat(
  cfg: Pick<ClientRepeat, "customerColumn" | "dateColumn" | "contactColumn" | "productColumn" | "amountColumn" | "leadDays" | "minOrders">,
  t: Pick<DataTable, "columns" | "rows">,
  today: string,
): RepeatCustomer[] {
  const cols = t.columns.map((c) => c.name);
  const ui = cols.indexOf(cfg.customerColumn);
  const di = cols.indexOf(cfg.dateColumn);
  if (ui < 0 || di < 0) throw new Error("columns");
  const ci = cols.indexOf(cfg.contactColumn);
  const pi = cols.indexOf(cfg.productColumn);
  const ai = cols.indexOf(cfg.amountColumn);
  const by = new Map<string, { name: string; contact: string; dates: string[]; total: number | null; products: Map<string, number> }>();
  for (const row of t.rows) {
    const name = (row[ui] ?? "").trim();
    const date = toIsoDate(row[di] ?? "");
    if (!name || !date || date > today) continue;
    const key = name.toLowerCase();
    const c = by.get(key) ?? { name, contact: "", dates: [] as string[], total: null as number | null, products: new Map<string, number>() };
    c.dates.push(date);
    if (ci >= 0 && row[ci]?.trim()) c.contact = row[ci].trim();
    if (pi >= 0 && row[pi]?.trim()) c.products.set(row[pi].trim(), (c.products.get(row[pi].trim()) ?? 0) + 1);
    const amount = ai >= 0 ? toNumber(row[ai]) : null;
    if (amount != null) c.total = (c.total ?? 0) + amount;
    by.set(key, c);
  }
  const out: RepeatCustomer[] = [];
  for (const c of by.values()) {
    const dates = [...new Set(c.dates)].sort();
    if (dates.length < Math.max(2, cfg.minOrders)) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d)).filter((g) => g > 0);
    if (!gaps.length) continue;
    const interval = Math.max(1, Math.round(median(gaps)));
    const lastDate = dates.at(-1)!;
    const nextDate = addDays(lastDate, interval);
    const daysLeft = daysBetween(today, nextDate);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const cv = gaps.length > 1 ? Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length) / mean : 0.5;
    const regularity = 1 - Math.min(cv, 1);
    const history = Math.min(dates.length / 6, 1);
    let p = 0.25 + 0.45 * regularity + 0.3 * history;
    const overdue = -daysLeft;
    let status: RepeatStatus = daysLeft <= cfg.leadDays ? "due" : "later";
    if (overdue > interval * 0.5) status = "late";
    if (overdue > interval * 1.5) {
      status = "lost";
      p *= 0.4;
    } else if (overdue > interval * 0.5) p *= 0.75;
    out.push({
      customer: c.name,
      contact: c.contact,
      orders: dates.length,
      lastDate,
      interval,
      nextDate,
      daysLeft,
      probability: Math.round(Math.min(0.95, Math.max(0.05, p)) * 100),
      status,
      total: c.total == null ? null : Math.round(c.total * 100) / 100,
      products: [...c.products.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
    });
  }
  const rank: Record<RepeatStatus, number> = { due: 0, late: 1, later: 2, lost: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.daysLeft - b.daysLeft);
}

export async function loadRepeat(clientId: string) {
  const [cfg] = await db.select().from(clientRepeat).where(eq(clientRepeat.clientId, clientId));
  if (!cfg?.tableId) return null;
  const [raw] = await db.select().from(dataTables).where(eq(dataTables.id, cfg.tableId));
  if (!raw) return null;
  return { cfg, table: await refreshTable(raw) };
}

async function writeNudge(cfg: ClientRepeat, c: RepeatCustomer, company: { name: string; brandVoice: string }) {
  const key = apiKey("anthropic");
  if (!key) throw new Error("no_key");
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ text: string }>(key, MODEL, {
    system: [
      `Ты пишешь короткое личное сообщение постоянному клиенту от компании «${company.name}».`,
      company.brandVoice ? `Голос бренда: ${company.brandVoice}` : "",
      `Что предложить: ${cfg.brief || "мягко напомнить, что пора повторить заказ, и предложить помочь оформить"}.`,
      "2–4 предложения, тепло и по делу, без давления и восклицаний; упомяни, что он обычно берёт (если известно). Не выдумывай скидок и условий, которых нет в задании. Язык — русский, если в данных клиента нет признаков другого.",
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: `Клиент: ${c.customer}. Заказов: ${c.orders}, обычно раз в ${c.interval} дн., последний ${c.lastDate}.${c.products.length ? ` Обычно берёт: ${c.products.join(", ")}.` : ""}`,
    schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
    effort: "low",
  });
  await logUsage({ source: "generate", model, usage, clientId: cfg.clientId, ms: Date.now() - started }).catch(() => {});
  return data.text.trim().slice(0, 1500);
}

/** Напомнить тем, кому пора (status due/late), — один раз на цикл покупки. */
async function runRepeat__(clientId: string, now = new Date()) {
  const found = await loadRepeat(clientId);
  if (!found) return { sent: 0, noChat: [] as string[], failed: 0 };
  const { cfg, table } = found;
  const [client] = await db.select({ name: clients.name, brandVoice: clients.brandVoice }).from(clients).where(eq(clients.id, clientId));
  const list = predictRepeat(cfg, table, kyivNow(now).date).filter((c) => (c.status === "due" || c.status === "late") && c.contact);
  const res = { sent: 0, noChat: [] as string[], failed: 0 };
  for (const c of list.slice(0, PER_RUN)) {
    const [slot] = await db.insert(repeatNudges).values({ clientId, customer: c.customer.toLowerCase(), lastOrder: c.lastDate, status: "sending" }).onConflictDoNothing().returning();
    if (!slot) continue;
    let status = "sent";
    let error: string | null = null;
    let message = "";
    try {
      message = await writeNudge(cfg, c, { name: client?.name ?? "", brandVoice: client?.brandVoice ?? "" });
      const out = await reach(clientId, parseContact(c.contact), { text: message, subject: client?.name, name: c.customer, mailChannelId: cfg.channelId, meta: { campaign: { id: "repeat", name: "Повторная покупка", step: 0 } } });
      status = out.status;
      if (out.status === "sent") res.sent++;
      else res.noChat.push(c.customer);
    } catch (e) {
      status = "failed";
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      res.failed++;
    }
    await db.update(repeatNudges).set({ status, error, message }).where(eq(repeatNudges.id, slot.id));
  }
  await db.update(clientRepeat).set({ lastRunAt: now, lastResult: `sent ${res.sent}, no chat ${res.noChat.length}, failed ${res.failed}` }).where(eq(clientRepeat.clientId, clientId));
  if (res.sent || res.noChat.length) {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = [
      "🔁 <b>Повторные покупки</b>",
      `Напомнил постоянным клиентам: ${res.sent}`,
      res.noChat.length ? `Пора покупать, но нет чата или почты — свяжитесь сами: ${esc(res.noChat.slice(0, 30).join(", "))}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const n = await import("@/lib/notify/telegram");
    await n.sendToTeam(html).catch(() => {});
    await n.sendToOwners(clientId, html).catch(() => {});
  }
  return res;
}

export async function runRepeat(clientId: string, now = new Date()) {
  return withKeys({ clientId }, () => runRepeat__(clientId, now));
}

/** Раз в 10 минут: клиенты с включёнными напоминаниями — один раз в день начиная с заданного часа. */
export async function repeatTick(now = new Date()) {
  const { quietUntil } = await import("@/lib/campaigns/engine");
  if (quietUntil(now)) return;
  const k = kyivNow(now);
  for (const cfg of await db.select().from(clientRepeat).where(eq(clientRepeat.auto, true))) {
    if (k.hour < cfg.hour || (cfg.lastRunAt && kyivNow(cfg.lastRunAt).date === k.date)) continue;
    await runRepeat(cfg.clientId, now).catch((e) => console.error("repeat failed", cfg.clientId, e));
  }
}
