import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { bills, currentMonth } from "@/lib/billing";
import { getBrand } from "@/lib/whitelabel";
import { logoDataUri } from "@/lib/client-logo";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Счёт клиенту за месяц (HTML для печати и сохранения в PDF). Только администратор. Оформление — в бренде студии:
 * полоса и итог её цветом, логотипы студии и клиента, номер счёта, кнопка «Печать / PDF» (на бумагу не попадает).
 */
export async function GET(req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const me = await findCurrentUser();
  if (!me || me.role !== "admin") return new Response("Forbidden", { status: 403 });
  const { clientId } = await params;
  const raw = new URL(req.url).searchParams.get("month") ?? "";
  const month = /^\d{4}-\d{2}$/.test(raw) ? raw : currentMonth();
  const [b] = await bills(month, clientId);
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!b || !c) return new Response("Not found", { status: 404 });
  const [brand, clientLogo] = await Promise.all([getBrand(), logoDataUri(clientId)]);
  const color = /^#[0-9a-f]{6}$/i.test(brand.color) ? brand.color : "#c2410c";
  const [y, m] = month.split("-").map(Number);
  const period = new Date(y, m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const issued = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const number = `${month.replace("-", "")}-${clientId.slice(0, 4).toUpperCase()}`;
  const money = (v: number) => `${v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${esc(b.currency)}`;
  const rows = [
    b.fee ? ["Абонплата за обслуживание ИИ-агентов", money(b.fee)] : null,
    b.aiBilled ? ["Работа моделей ИИ сверх включённого объёма", money(b.aiBilled)] : null,
    b.channelBilled ? ["Сообщения WhatsApp Business", money(b.channelBilled)] : null,
  ].filter(Boolean) as string[][];
  const studioMark = brand.logo.startsWith("https://")
    ? `<img src="${esc(brand.logo)}" alt="" class="studio-logo">`
    : `<span class="mark" style="background:${color}">${esc(brand.logo || brand.name.charAt(0))}</span>`;
  const clientMark = clientLogo ? `<img src="${clientLogo}" alt="" class="client-logo">` : "";
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Счёт ${number} — ${esc(c.name)} — ${period}</title>
<style>
:root{--brand:${color}}
*{box-sizing:border-box}
body{font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#14161a;background:#eef0f3;margin:0;padding:32px 16px}
.sheet{max-width:780px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(20,22,26,.08);overflow:hidden}
.band{height:6px;background:var(--brand)}
.wrap{padding:36px 40px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
.studio{display:flex;align-items:center;gap:12px;font-weight:700;font-size:17px}
.mark{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;color:#fff;font-weight:700;font-size:18px}
.studio-logo{height:40px;width:auto}
.doc{text-align:right}
.doc h1{margin:0;font-size:26px;letter-spacing:-.02em}
.muted{color:#646b78;font-size:13px}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:32px 0 8px;padding:20px;border-radius:12px;background:#f6f7f9}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#646b78;margin-bottom:6px}
.client{display:flex;align-items:center;gap:12px}
.client-logo{width:44px;height:44px;object-fit:contain;border-radius:10px;background:#fff;border:1px solid #e1e4e9}
.name{font-weight:600}
table{border-collapse:collapse;width:100%;margin-top:24px}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#646b78;font-weight:600;text-align:left;padding:10px 0;border-bottom:1px solid #e1e4e9}
td{padding:14px 0;border-bottom:1px solid #eef0f3}
td:last-child,th:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.total{display:flex;justify-content:space-between;align-items:center;margin-top:20px;padding:18px 20px;border-radius:12px;background:color-mix(in srgb,var(--brand) 10%,#fff)}
.total b{font-size:24px;color:var(--brand);font-variant-numeric:tabular-nums}
.note{margin-top:24px}
.foot{margin-top:32px;padding-top:16px;border-top:1px solid #eef0f3;display:flex;justify-content:space-between;gap:16px}
.print{position:fixed;right:20px;bottom:20px;border:0;border-radius:12px;padding:12px 18px;background:var(--brand);color:#fff;font:600 14px/1 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.18)}
@media (max-width:600px){.wrap{padding:24px 20px}.top,.parties{grid-template-columns:1fr;display:grid}.doc{text-align:left}}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:none}.print{display:none}}
</style></head><body>
<div class="sheet"><div class="band"></div><div class="wrap">
<div class="top">
  <div class="studio">${studioMark}<span>${esc(brand.name)}</span></div>
  <div class="doc"><h1>Счёт № ${number}</h1><div class="muted">за ${period} · выставлен ${issued}</div></div>
</div>
<div class="parties">
  <div><div class="label">Исполнитель</div><div class="name">${esc(brand.name)}</div>${brand.support ? `<div class="muted">${esc(brand.support)}</div>` : ""}</div>
  <div><div class="label">Клиент</div><div class="client">${clientMark}<div><div class="name">${esc(c.name)}</div>${c.website ? `<div class="muted">${esc(c.website)}</div>` : ""}</div></div></div>
</div>
<table><thead><tr><th>Услуга</th><th>Сумма</th></tr></thead><tbody>
${rows.map(([a, v]) => `<tr><td>${a}</td><td>${v}</td></tr>`).join("") || `<tr><td>Начислений нет</td><td>${money(0)}</td></tr>`}
</tbody></table>
<div class="total"><span>Итого к оплате</span><b>${money(b.total)}</b></div>
<p class="muted note">Расходы на модели ИИ по вашим собственным ключам оплачиваются напрямую провайдеру и в счёт не входят.</p>
<div class="foot muted"><span>${esc(brand.name)}</span><span>Счёт № ${number}</span></div>
</div></div>
<button class="print" onclick="window.print()">Печать / PDF</button>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
