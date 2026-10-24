"use client";

import { useState, useTransition } from "react";
import { Check, KeyRound, Trash2 } from "lucide-react";
import { saveClientKey } from "@/app/actions/client-keys";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Input, Spinner } from "@/components/ui";

type Kind = "anthropic" | "openai" | "openrouter" | "googleMaps";
export type KeyView = { kind: Kind; masked: string | null; studio: boolean };

/** Свои ключи клиента: в браузер приходят только замаскированные значения. */
export function ClientKeys({ clientId, keys, ownSpend }: { clientId: string; keys: KeyView[]; ownSpend: number }) {
  const { t } = useI18n();
  const k = t.clientKeys;
  return (
    <Card className="mt-8 space-y-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <KeyRound className="size-4 text-accent" />
          {k.title}
        </h2>
        <p className="mt-1 text-sm text-muted">{k.hint}</p>
        {ownSpend > 0 && <p className="mt-1 text-xs text-muted">{k.spend.replace("{usd}", ownSpend.toFixed(2))}</p>}
      </div>
      <div className="divide-y divide-border">
        {keys.map((v) => (
          <KeyRow key={v.kind} clientId={clientId} view={v} />
        ))}
      </div>
    </Card>
  );
}

function KeyRow({ clientId, view }: { clientId: string; view: KeyView }) {
  const { t } = useI18n();
  const k = t.clientKeys;
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ error?: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = (v: string) =>
    start(async () => {
      setMsg(null);
      const r = await saveClientKey(clientId, view.kind, v);
      if (r.error) setMsg({ error: true, text: (k.errors as Record<string, string>)[r.error] ?? r.error });
      else {
        setValue("");
        setMsg({ text: v ? k.saved : k.removed });
      }
    });
  return (
    <div className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{k.kinds[view.kind]}</span>
        {view.masked ? (
          <Badge tone="success">
            <Check className="size-3" /> {k.own} · <code className="font-mono">{view.masked}</code>
          </Badge>
        ) : (
          <Badge tone="neutral">{view.studio ? k.studio : k.none}</Badge>
        )}
      </div>
      <p className="text-xs text-muted">{k.uses[view.kind]}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          className="min-w-64 flex-1 font-mono text-[13px]"
          value={value}
          maxLength={500}
          placeholder={view.masked ? k.replacePlaceholder : k.placeholder[view.kind]}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button size="sm" disabled={pending || !value.trim()} onClick={() => save(value)}>
          {pending ? <Spinner /> : <Check className="size-4" />}
          {k.save}
        </Button>
        {view.masked && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm(k.confirmRemove) && save("")}>
            <Trash2 className="size-4" />
            {k.remove}
          </Button>
        )}
      </div>
      {msg && <p className={msg.error ? "text-sm text-danger" : "text-sm text-success"}>{msg.text}</p>}
    </div>
  );
}
