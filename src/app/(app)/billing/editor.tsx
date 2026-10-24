"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { saveBilling, type BillingInput } from "@/app/actions/billing";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input } from "@/components/ui";

type Terms = { currency: string; usdRate: number; fee: number; markupPct: number; channelMarkupPct: number; includedUsd: number; limitUsd: number | null };

/** Условия клиента: валюта и курс, абонплата, наценки, включённый объём, лимит. */
export function BillingEditor({ clientId, client, month, initial }: { clientId: string; client: string; month: string; initial: Terms }) {
  const { t } = useI18n();
  const b = t.billing;
  const [v, setV] = useState<Terms>({ currency: initial.currency, usdRate: initial.usdRate, fee: initial.fee, markupPct: initial.markupPct, channelMarkupPct: initial.channelMarkupPct, includedUsd: initial.includedUsd, limitUsd: initial.limitUsd });
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const num = (k: keyof Terms, label: string, hint?: string, step = "0.01") => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={0}
        step={step}
        className="w-36"
        value={v[k] ?? ""}
        onChange={(e) => setV({ ...v, [k]: e.target.value === "" ? (k === "limitUsd" ? null : 0) : Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <Card className="space-y-4 border-accent/40 p-5">
      <div className="font-semibold">
        {b.termsFor} «{client}»
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={b.currency}>
          <Input className="w-24" value={v.currency} maxLength={5} onChange={(e) => setV({ ...v, currency: e.target.value })} />
        </Field>
        {num("usdRate", b.usdRate, b.usdRateHint, "0.0001")}
        {num("fee", b.feeLabel)}
        {num("includedUsd", b.included, b.includedHint)}
        {num("markupPct", b.markup, b.markupHint)}
        {num("channelMarkupPct", b.channelMarkup)}
        {num("limitUsd", b.limitLabel, b.limitHint)}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveBilling(clientId, v as BillingInput);
              setMsg(r.error ? { error: true, text: b.invalid } : { text: t.common.saved });
            })
          }
        >
          {t.common.save}
        </Button>
        <Link href={`/billing?month=${month}`} className="text-sm text-muted hover:text-text">
          {t.common.cancel}
        </Link>
        {msg && <span className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</span>}
      </div>
    </Card>
  );
}
