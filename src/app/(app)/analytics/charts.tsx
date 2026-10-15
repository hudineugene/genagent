"use client";

import { useI18n } from "@/lib/i18n/client";
import { ColumnChart, StatTile, type Column } from "@/components/charts";
import { Card, cx } from "@/components/ui";

/** Плитки показателей и два отдельных графика (диалоги и расходы — разные шкалы, поэтому не на одной оси). */
export function AnalyticsCharts({
  tiles,
  conversations,
  costs,
}: {
  tiles: { label: string; value: string; hint?: string }[];
  conversations: Column[];
  costs: Column[];
}) {
  const { t } = useI18n();
  const money = (v: number) => (v >= 1 ? `$${v.toFixed(v >= 100 ? 0 : 2)}` : `$${v.toFixed(v === 0 ? 0 : 3)}`);
  return (
    <>
      <div className={cx("grid grid-cols-2 gap-3 sm:grid-cols-3", tiles.length > 6 ? "sm:grid-cols-4 lg:grid-cols-7" : "lg:grid-cols-6")}>
        {tiles.map((x) => (
          <StatTile key={x.label} {...x} />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
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
