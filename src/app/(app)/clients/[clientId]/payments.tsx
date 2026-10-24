"use client";

import { useState, useTransition } from "react";
import { CreditCard, RefreshCw } from "lucide-react";
import { recheckPayment, savePayments, testPaymentLink, type PaymentsInput } from "@/app/actions/payments";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";

export type PaymentsView = {
  provider: "liqpay" | "wayforpay" | "monobank";
  publicKey: string;
  merchant: string;
  domain: string;
  /** Замаскированные секреты (••••1234) — сами ключи в браузер не отдаются */
  privateKeyMask: string;
  secretMask: string;
  tokenMask: string;
  currency: "UAH" | "USD" | "EUR";
  maxAmount: number | null;
  paidText: string;
  enabled: boolean;
};
export type PaymentRow = { id: string; at: string; amount: number; currency: string; description: string; status: string; contact: string; conversationId: string | null };

const TONE: Record<string, "success" | "warning" | "accent" | "neutral"> = { paid: "success", created: "accent", failed: "warning", expired: "neutral", refunded: "neutral" };

export function PaymentsManager({ clientId, initial, list, month }: { clientId: string; initial: PaymentsView | null; list: PaymentRow[]; month: { paid: number; sum: string; links: number } }) {
  const { t } = useI18n();
  const p = t.payments;
  const [v, setV] = useState<PaymentsView>(
    initial ?? { provider: "liqpay", publicKey: "", merchant: "", domain: "", privateKeyMask: "", secretMask: "", tokenMask: "", currency: "UAH", maxAmount: null, paidText: "", enabled: true },
  );
  const [secrets, setSecrets] = useState({ privateKey: "", secret: "", token: "" });
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof PaymentsView>(k: K, val: PaymentsView[K]) => setV({ ...v, [k]: val });
  const secretField = (k: keyof typeof secrets, label: string, mask: string) => (
    <Field label={label} hint={mask ? p.keepSecret : undefined}>
      <Input className="w-80" type="password" autoComplete="off" value={secrets[k]} placeholder={mask || ""} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
    </Field>
  );
  const err = (code?: string) => (p.errors as Record<string, string>)[code ?? ""] ?? code ?? "";

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{p.subtitle}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">{p.monthPaid}</div>
          <div className="text-xl font-semibold">{month.sum || "—"}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">{p.monthCount}</div>
          <div className="text-xl font-semibold">{month.paid}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">{p.monthLinks}</div>
          <div className="text-xl font-semibold">{month.links}</div>
        </Card>
      </div>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap gap-3">
          <Field label={p.provider}>
            <Select className="w-56" value={v.provider} onChange={(e) => set("provider", e.target.value as PaymentsView["provider"])}>
              <option value="liqpay">LiqPay (ПриватБанк)</option>
              <option value="wayforpay">WayForPay</option>
              <option value="monobank">Monobank (эквайринг)</option>
            </Select>
          </Field>
          <Field label={p.currency}>
            <Select className="w-28" value={v.currency} onChange={(e) => set("currency", e.target.value as PaymentsView["currency"])}>
              <option value="UAH">UAH</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </Select>
          </Field>
          <Field label={p.maxAmount} hint={p.maxAmountHint}>
            <Input
              type="number"
              min={0}
              className="w-36"
              value={v.maxAmount ?? ""}
              onChange={(e) => set("maxAmount", e.target.value ? Math.max(0, Number(e.target.value)) || null : null)}
            />
          </Field>
        </div>
        {v.provider === "liqpay" ? (
          <div className="flex flex-wrap gap-3">
            <Field label={p.publicKey}>
              <Input className="w-80" value={v.publicKey} onChange={(e) => set("publicKey", e.target.value)} />
            </Field>
            {secretField("privateKey", p.privateKey, v.privateKeyMask)}
          </div>
        ) : v.provider === "wayforpay" ? (
          <div className="flex flex-wrap gap-3">
            <Field label={p.merchant}>
              <Input className="w-64" value={v.merchant} onChange={(e) => set("merchant", e.target.value)} />
            </Field>
            {secretField("secret", p.secret, v.secretMask)}
            <Field label={p.domain} hint={p.domainHint}>
              <Input className="w-64" value={v.domain} placeholder="shop.com.ua" onChange={(e) => set("domain", e.target.value)} />
            </Field>
          </div>
        ) : (
          secretField("token", p.token, v.tokenMask)
        )}
        <p className="text-xs text-muted">{(p.where as Record<string, string>)[v.provider]}</p>
        <Field label={p.paidText} hint={p.paidTextHint}>
          <Textarea rows={2} maxLength={500} value={v.paidText} placeholder={p.paidTextPlaceholder} onChange={(e) => set("paidText", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          {p.enabled}
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const input: PaymentsInput = { provider: v.provider, publicKey: v.publicKey, merchant: v.merchant, domain: v.domain, currency: v.currency, maxAmount: v.maxAmount, paidText: v.paidText, enabled: v.enabled, ...secrets };
                const r = await savePayments(clientId, input);
                setMsg(r.error ? { error: true, text: err(r.error) } : { text: p.saved });
                if (!r.error) setSecrets({ privateKey: "", secret: "", token: "" });
              })
            }
          >
            {p.save}
          </Button>
          <Button
            variant="secondary"
            disabled={pending || !initial}
            onClick={() =>
              start(async () => {
                const r = await testPaymentLink(clientId);
                setLink(r.link ?? null);
                setMsg(r.error ? { error: true, text: err(r.error) } : null);
              })
            }
          >
            <CreditCard className="size-4" />
            {p.test}
          </Button>
          {msg && <span className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</span>}
        </div>
        {link && (
          <p className="text-sm">
            {p.testLink}{" "}
            <a href={link} target="_blank" rel="noopener" className="break-all text-accent hover:underline">
              {link}
            </a>
          </p>
        )}
        <p className="text-xs text-muted">{p.agentHint}</p>
      </Card>
      <Card className="p-5">
        <div className="mb-3 font-semibold">{p.list}</div>
        {list.length === 0 ? (
          <p className="text-sm text-muted">{p.empty}</p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {list.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-32 shrink-0 text-xs text-muted">{x.at}</span>
                <span className="w-28 shrink-0 font-medium">
                  {x.amount} {x.currency}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {x.description}
                  {x.contact && <span className="text-muted"> · {x.contact}</span>}
                </span>
                <Badge tone={TONE[x.status] ?? "neutral"}>{(p.status as Record<string, string>)[x.status] ?? x.status}</Badge>
                {x.status === "created" && (
                  <Button size="sm" variant="ghost" disabled={pending} title={p.recheck} onClick={() => start(async () => void (await recheckPayment(x.id)))}>
                    <RefreshCw className="size-4" />
                  </Button>
                )}
                {x.conversationId && (
                  <a href={`/inbox?c=${x.conversationId}`} className="text-xs text-accent hover:underline">
                    {p.open}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
