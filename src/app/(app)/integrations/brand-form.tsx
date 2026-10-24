"use client";

import { useState, useTransition } from "react";
import { saveBrandAction } from "@/app/actions/portal";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input } from "@/components/ui";

/** Бренд студии в кабинете клиента: название, цвет, логотип, контакт поддержки. */
export function BrandForm({ initial }: { initial: { name: string; color: string; logo: string; support: string } }) {
  const { t } = useI18n();
  const b = t.brand;
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-4 p-5">
      <div className="font-semibold">{b.title}</div>
      <p className="text-sm text-muted">{b.hint}</p>
      <div className="flex flex-wrap gap-3">
        <Field label={b.name}>
          <Input className="w-56" value={v.name} maxLength={60} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label={b.color}>
          <input type="color" className="h-10 w-16 cursor-pointer rounded-lg border border-border bg-surface" value={v.color} onChange={(e) => setV({ ...v, color: e.target.value })} />
        </Field>
        <Field label={b.logo} hint={b.logoHint}>
          <Input className="w-72" value={v.logo} maxLength={500} placeholder="https://… или 🦷" onChange={(e) => setV({ ...v, logo: e.target.value })} />
        </Field>
        <Field label={b.support}>
          <Input className="w-64" value={v.support} maxLength={200} placeholder="+380… · @studio" onChange={(e) => setV({ ...v, support: e.target.value })} />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await saveBrandAction(v);
              setMsg(r.error ? { error: true, text: b.invalid } : { text: t.common.saved });
            })
          }
        >
          {t.common.save}
        </Button>
        {msg && <span className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</span>}
      </div>
    </Card>
  );
}
