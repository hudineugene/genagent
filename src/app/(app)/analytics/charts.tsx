"use client";

import { useI18n } from "@/lib/i18n/client";
import { ColumnChart, StatTile, type Column } from "@/components/charts";
import { Card } from "@/components/ui";

/** Плитки показателей и два отдельных графика (диалоги и расходы — разные шкалы, поэтому не на одной оси). */
export function AnalyticsCharts({
  tiles,
  extra = [],
  conversations,
  costs,
}: {
  tiles: { label: string; value: string; hint?: string }[];
  /** Второстепенные показатели — одной строкой под плитками */
  extra?: string[];
  conversations: Column[];
  costs: Column[];
}) {
  const { t } = useI18n();
  const money = (v: number) => (v >= 1 ? `$${v.toFixed(v >= 100 ? 0 : 2)}` : `$${v.toFixed(v === 0 ? 0 : 3)}`);
  return (
    <>
      <div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((x) => (
            <StatTile key={x.label} {...x} />
          ))}
        </div>
        {extra.length > 0 && <p className="mt-2.5 px-1 text-xs text-muted">{extra.join(" · ")}</p>}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <ColumnChart
            title={t.analytics.conversationsByDay}
            data={conversations}
            integer
            tableLabel={t.analytics.showTable}
            chartLabel={t.analytics.showChart}
          />
        </Card>
        <Card className="p-5">
          <ColumnChart
            title={t.analytics.spendByDay}
            data={costs}
            format={money}
            tableLabel={t.analytics.showTable}
            chartLabel={t.analytics.showChart}
          />
        </Card>
      </div>
    </>
  );
}
