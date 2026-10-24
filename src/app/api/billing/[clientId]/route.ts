import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { bills, currentMonth } from "@/lib/billing";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Счёт клиенту за месяц (HTML для печати и сохранения в PDF). Только администратор. */
export async function GET(req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const me = await findCurrentUser();
  if (!me || me.role !== "admin") return new Response("Forbidden", { status: 403 });
  const { clientId } = await params;
  const raw = new URL(req.url).searchParams.get("month") ?? "";
  const month = /^\d{4}-\d{2}$/.test(raw) ? raw : currentMonth();
  const [b] = await bills(month, clientId);
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!b || !c) return new Response("Not found", { status: 404 });
  const [y, m] = month.split("-").map(Number);
  const period = new Date(y, m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const money = (v: number) => `${v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${esc(b.currency)}`;
  const rows = [
    b.fee ? ["Абонплата за обслуживание ИИ-агентов", money(b.fee)] : null,
    b.aiBilled ? ["Работа моделей ИИ сверх включённого объёма", money(b.aiBilled)] : null,
    b.channelBilled ? ["Сообщения WhatsApp Business", money(b.channelBilled)] : null,
  ].filter(Boolean) as string[][];
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Счёт — ${esc(c.name)} — ${period}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}h1{font-size:22px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:24px}td,th{border-bottom:1px solid #ddd;padding:10px 8px;text-align:left}td:last-child,th:last-child{text-align:right}.total td{font-weight:700;border-bottom:2px solid #111}.muted{color:#666;font-size:13px}</style></head><body>
<h1>Счёт за ${period}</h1>
<div class="muted">Клиент: ${esc(c.name)}${c.website ? ` · ${esc(c.website)}` : ""}</div>
<table><thead><tr><th>Услуга</th><th>Сумма</th></tr></thead><tbody>
${rows.map(([a, v]) => `<tr><td>${a}</td><td>${v}</td></tr>`).join("") || `<tr><td>Начислений нет</td><td>${money(0)}</td></tr>`}
<tr class="total"><td>Итого к оплате</td><td>${money(b.total)}</td></tr></tbody></table>
<p class="muted">Расходы на модели ИИ по вашим собственным ключам оплачиваются напрямую провайдеру и в счёт не входят.</p>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
