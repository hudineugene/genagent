"use client";

import { useState, useTransition } from "react";
import { FileText, ShieldCheck } from "lucide-react";
import { saveRetention } from "@/app/actions/clients";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Input, buttonClass } from "@/components/ui";

export type SubprocessorRow = { name: string; purpose: string; location: string };

/** Данные и GDPR: срок хранения разговоров, обработчики данных, шаблон договора обработки данных (DPA). */
export function ClientPrivacy({ clientId, retentionDays, subs }: { clientId: string; retentionDays: number | null; subs: SubprocessorRow[] }) {
  const { t } = useI18n();
  const p = t.privacy;
  const [days, setDays] = useState(retentionDays ? String(retentionDays) : "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="mt-8 space-y-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="size-4 text-accent" />
          {p.title}
        </h2>
        <p className="mt-1 text-sm text-muted">{p.hint}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block font-medium">{p.retention}</span>
          <Input type="number" min={7} max={3650} className="w-32" value={days} placeholder={p.forever} onChange={(e) => setDays(e.target.value)} />
        </label>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const n = days.trim() ? Math.round(Number(days)) : null;
              const r = await saveRetention(clientId, n);
              setMsg(r.error ? { ok: false, text: p.invalid } : { ok: true, text: p.saved });
            })
          }
        >
          {p.save}
        </Button>
        {msg && <span className={msg.ok ? "text-sm text-success" : "text-sm text-danger"}>{msg.text}</span>}
      </div>
      <p className="text-xs text-muted">{p.retentionHint}</p>
      <div>
        <div className="mb-1 text-sm font-semibold">{p.subprocessors}</div>
        <ul className="space-y-0.5 text-sm">
          {subs.map((s) => (
            <li key={s.name}>
              <b>{s.name}</b> <span className="text-muted">— {s.purpose} · {s.location}</span>
            </li>
          ))}
        </ul>
      </div>
      <a href={`/api/dpa/${clientId}`} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
        <FileText className="size-4" />
        {p.dpa}
      </a>
      <p className="text-xs text-muted">{p.rights}</p>
    </Card>
  );
}
