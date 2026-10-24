"use client";

import { useState, useTransition } from "react";
import { DoorOpen, KeyRound, Trash2 } from "lucide-react";
import { addOwnerLogin, deleteOwnerLogin, resetOwnerLogin } from "@/app/actions/portal";
import { useI18n } from "@/lib/i18n/client";
import { Button, Card, Field, Input } from "@/components/ui";

/** Кабинет клиента: входы владельцев бизнеса (пароль показывается один раз) и предпросмотр кабинета. */
export function OwnerLogins({ clientId, rows }: { clientId: string; rows: { id: string; name: string; email: string }[] }) {
  const { t } = useI18n();
  const o = t.ownerLogins;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex flex-1 items-center gap-2 font-semibold">
          <DoorOpen className="size-[18px] text-accent" />
          {o.title}
        </h2>
        <a href={`/portal?client=${clientId}`} target="_blank" rel="noopener" className="text-sm text-accent hover:underline">
          {o.preview}
        </a>
      </div>
      <p className="text-sm text-muted">{o.hint}</p>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {r.name} · <span className="text-muted">{r.email}</span>
          </span>
          <Button size="sm" variant="ghost" title={o.reset} disabled={pending} onClick={() => confirm(o.resetConfirm) && start(async () => { const x = await resetOwnerLogin(r.id); if (x.password) setCreds({ email: x.email!, password: x.password }); })}>
            <KeyRound className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => confirm(t.common.confirmDelete) && start(() => deleteOwnerLogin(r.id))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={o.name}>
          <Input className="w-48" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={o.email}>
          <Input className="w-64" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button
          disabled={pending || !name.trim() || !email.trim()}
          onClick={() =>
            start(async () => {
              const r = await addOwnerLogin(clientId, { name, email });
              if (r.password) {
                setCreds({ email: r.email!, password: r.password });
                setName("");
                setEmail("");
                setError(null);
              } else setError((o.errors as Record<string, string>)[r.error ?? ""] ?? r.error ?? "");
            })
          }
        >
          {o.add}
        </Button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
      {creds && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="font-medium">{o.once}</div>
          <div className="mt-1 font-mono">
            {creds.email} · {creds.password}
          </div>
          <div className="mt-1 text-xs text-muted">{o.loginAt}</div>
        </div>
      )}
    </Card>
  );
}
