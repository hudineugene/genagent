"use client";

import { useState, useTransition } from "react";
import { Calculator, Plus, X } from "lucide-react";
import { savePricing, testQuote } from "@/app/actions/pricing";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import type { PriceTier } from "@/db/schema";

export type PricingRow = { tableId: string | null; nameColumn: string; priceColumn: string; tierBy: "amount" | "qty"; tiers: PriceTier[]; vat: number; currency: string; notes: string };
export type PriceTable = { id: string; name: string; columns: string[] };

export function PricingManager({ clientId, initial, tables }: { clientId: string; initial: PricingRow; tables: PriceTable[] }) {
  const { t } = useI18n();
  const p = t.pricing;
  const [v, setV] = useState<PricingRow>(initial);
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [lines, setLines] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const table = tables.find((x) => x.id === v.tableId);
  const set = <K extends keyof PricingRow>(k: K, val: PricingRow[K]) => setV({ ...v, [k]: val });
  const num = (s: string) => Math.max(0, Number(s.replace(",", ".")) || 0);
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{p.subtitle}</p>
      {tables.length === 0 && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">{p.noTables}</p>}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap gap-3">
          <Field label={p.table}>
            <Select className="w-56" value={v.tableId ?? ""} onChange={(e) => setV({ ...v, tableId: e.target.value || null, nameColumn: "", priceColumn: "" })}>
              <option value="">—</option>
              {tables.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          {table && (
            <>
              <Field label={p.nameColumn}>
                <Select className="w-48" value={v.nameColumn} onChange={(e) => set("nameColumn", e.target.value)}>
                  <option value="">—</option>
                  {table.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={p.priceColumn}>
                <Select className="w-48" value={v.priceColumn} onChange={(e) => set("priceColumn", e.target.value)}>
                  <option value="">—</option>
                  {table.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field label={p.currency}>
            <Input className="w-20" value={v.currency} maxLength={10} onChange={(e) => set("currency", e.target.value)} />
          </Field>
          <Field label={p.vat}>
            <Input type="number" min={0} max={100} className="w-24" value={v.vat} onChange={(e) => set("vat", Math.min(100, num(e.target.value)))} />
          </Field>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {p.tiers}
            <Select className="h-8 w-56 text-[13px]" value={v.tierBy} onChange={(e) => set("tierBy", e.target.value as PricingRow["tierBy"])}>
              <option value="amount">{p.tierBy.amount}</option>
              <option value="qty">{p.tierBy.qty}</option>
            </Select>
          </div>
          {v.tiers.map((x, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              {p.from}
              <Input type="number" min={0} className="w-32" value={x.from} onChange={(e) => set("tiers", v.tiers.map((y, j) => (j === i ? { ...y, from: num(e.target.value) } : y)))} />
              {v.tierBy === "amount" ? v.currency : p.pcs} →
              <Input type="number" min={0} max={100} className="w-20" value={x.percent} onChange={(e) => set("tiers", v.tiers.map((y, j) => (j === i ? { ...y, percent: Math.min(100, num(e.target.value)) } : y)))} />
              {p.percentOff}
              <Button size="sm" variant="ghost" onClick={() => set("tiers", v.tiers.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => set("tiers", [...v.tiers, { from: v.tiers.length ? Math.max(...v.tiers.map((x) => x.from)) * 2 || 1000 : 1000, percent: 5 }])}>
            <Plus className="size-4" />
            {p.addTier}
          </Button>
        </div>
        <Field label={p.notes} hint={p.notesHint}>
          <Textarea rows={2} value={v.notes} maxLength={1000} placeholder={p.notesPlaceholder} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <div className="flex items-center gap-3">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await savePricing(clientId, v);
                setMsg(r.error ? { error: true, text: p.errors.invalid } : { text: p.saved });
              })
            }
          >
            {p.save}
          </Button>
          {msg && <span className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</span>}
        </div>
      </Card>
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2 font-semibold">
          <Calculator className="size-4 text-accent" />
          {p.test}
        </div>
        <Textarea rows={4} className="font-mono text-[13px]" value={lines} placeholder={p.testPlaceholder} onChange={(e) => setLines(e.target.value)} />
        <Button
          size="sm"
          disabled={pending || !lines.trim()}
          onClick={() =>
            start(async () => {
              const r = await testQuote(clientId, lines);
              setQuote(r.text ?? ((p.errors as Record<string, string>)[r.error ?? ""] ?? r.error ?? ""));
            })
          }
        >
          {p.calc}
        </Button>
        {quote && <pre className="whitespace-pre-wrap rounded-lg bg-surface-2/60 p-3 text-sm">{quote}</pre>}
      </Card>
    </div>
  );
}
