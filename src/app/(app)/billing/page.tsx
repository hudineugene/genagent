import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clientBilling } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { bills, currentMonth, DEFAULT_BILLING } from "@/lib/billing";
import { Card, PageHeader, cx } from "@/components/ui";
import { BillingEditor } from "./editor";

/** Биллинг студии: по каждому клиенту за месяц — себестоимость, к оплате, маржа; условия клиента; счёт. */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ month?: string; edit?: string }> }) {
  await requireAdmin();
  const { t } = await getT();
  const b = t.billing;
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : currentMonth();
  const list = (await bills(month)).sort((x, y) => y.total - x.total || y.aiCost - x.aiCost);
  const [y, m] = month.split("-").map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  const totals = new Map<string, { total: number; margin: number }>();
  for (const x of list) {
    const cur = totals.get(x.currency) ?? { total: 0, margin: 0 };
    totals.set(x.currency, { total: cur.total + x.total, margin: cur.margin + x.margin });
  }
  const money = (v: number, cur: string) => `${v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${cur}`;
  const usd = (v: number) => `$${v.toFixed(2)}`;
  const editing = sp.edit ? (await db.select().from(clientBilling).where(eq(clientBilling.clientId, sp.edit)))[0] : null;
  const editClient = sp.edit ? list.find((x) => x.clientId === sp.edit) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={b.title} subtitle={b.subtitle} />
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/billing?month=${prev}`} className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2">
          ←
        </Link>
        <span className="font-semibold">{new Date(y, m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}</span>
        <Link href={`/billing?month=${next}`} className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-2">
          →
        </Link>
        <span className="ml-auto text-sm text-muted">
          {[...totals].map(([cur, v]) => `${b.totalBilled}: ${money(v.total, cur)} · ${b.margin}: ${money(v.margin, cur)}`).join("  |  ")}
        </span>
      </div>
      {editClient && (
        <BillingEditor clientId={editClient.clientId} client={editClient.client} month={month} initial={editing ? { ...editing } : { ...DEFAULT_BILLING }} />
      )}
      <Card className="overflow-x-auto p-5">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th className="py-2 pr-3 font-medium">{b.client}</th>
              <th className="py-2 pr-3 text-right font-medium">{b.aiCost}</th>
              <th className="py-2 pr-3 text-right font-medium">{b.channelCost}</th>
              <th className="py-2 pr-3 text-right font-medium">{b.ownKey}</th>
              <th className="py-2 pr-3 text-right font-medium">{b.fee}</th>
              <th className="py-2 pr-3 text-right font-medium">{b.total}</th>
              <th className="py-2 pr-3 text-right font-medium">{b.margin}</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.clientId} className="border-b border-border last:border-0">
                <td className="py-2 pr-3">
                  <Link href={`/clients/${x.clientId}`} className="hover:text-accent">
                    {x.client}
                  </Link>
                  {!x.configured && <div className="text-xs text-amber-600 dark:text-amber-400">{b.notConfigured}</div>}
                  {x.limitUsd != null && (
                    <div className={cx("text-xs", x.aiCost + x.channelCost >= x.limitUsd ? "text-danger" : "text-muted")}>
                      {b.limit}: {usd(x.aiCost + x.channelCost)} / {usd(x.limitUsd)}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{usd(x.aiCost)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{usd(x.channelCost)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">{usd(x.aiOwnKey)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(x.fee, x.currency)}</td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums">{money(x.total, x.currency)}</td>
                <td className={cx("py-2 pr-3 text-right tabular-nums", x.margin < 0 ? "text-danger" : "text-success")}>{money(x.margin, x.currency)}</td>
                <td className="py-2 text-right whitespace-nowrap">
                  <Link href={`/billing?month=${month}&edit=${x.clientId}`} className="text-xs text-accent hover:underline">
                    {b.terms}
                  </Link>
                  {" · "}
                  <a href={`/api/billing/${x.clientId}?month=${month}`} target="_blank" rel="noopener" className="text-xs text-accent hover:underline">
                    {b.invoice}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted">{b.note}</p>
      </Card>
    </div>
  );
}

export const instant = false;
