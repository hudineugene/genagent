"use client";

import { useState, useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { confirmTwoFactor, disableTwoFactor, startTwoFactor } from "@/app/actions/profile";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input } from "@/components/ui";

/** Двухфакторный вход: QR для приложения → код → коды восстановления; отключение — только с кодом. */
export function TwoFactor({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const p = t.profile.twoFactor;
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const on = enabled || Boolean(codes);
  return (
    <Card className="space-y-4 p-6">
      <h2 className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="size-[18px] text-accent" />
        {p.title}
        <Badge tone={on ? "success" : "neutral"}>{on ? p.on : p.off}</Badge>
      </h2>
      <p className="text-sm text-muted">{p.hint}</p>
      {codes ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{p.codesTitle}</p>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2/60 p-3 font-mono text-sm">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <p className="text-xs text-muted">{p.codesHint}</p>
        </div>
      ) : setup ? (
        <div className="space-y-3">
          <p className="text-sm">{p.scan}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR" width={180} height={180} className="rounded-lg bg-white p-1" />
          <p className="text-xs text-muted">
            {p.manual} <span className="font-mono">{setup.secret}</span>
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={p.code}>
              <Input className="w-40 font-mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button
              disabled={pending || code.trim().length < 6}
              onClick={() =>
                start(async () => {
                  const r = await confirmTwoFactor(code);
                  if (r.codes) {
                    setCodes(r.codes);
                    setError(null);
                  } else setError(r.error === "locked" ? p.codeLocked : p.badCode);
                })
              }
            >
              {p.confirm}
            </Button>
          </div>
        </div>
      ) : enabled ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={p.codeToDisable}>
            <Input className="w-40 font-mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Button
            variant="danger"
            disabled={pending || code.trim().length < 6}
            onClick={() =>
              start(async () => {
                const r = await disableTwoFactor(code);
                if (r.error) setError(r.error === "locked" ? p.codeLocked : p.badCode);
                else {
                  setCode("");
                  setError(null);
                }
              })
            }
          >
            {p.disable}
          </Button>
        </div>
      ) : (
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await startTwoFactor();
              if (r.qr && r.secret) setSetup({ qr: r.qr, secret: r.secret });
            })
          }
        >
          {p.enable}
        </Button>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}
