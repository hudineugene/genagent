"use client";

import { useState, useTransition } from "react";
import { KeyRound } from "lucide-react";
import { createApiKey, revokeApiKey } from "@/app/actions/api-keys";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";

export type ApiKeyRow = { id: string; name: string; prefix: string; scope: "read" | "write"; clients: string; lastUsedAt: string | null; revoked: boolean };

/** Ключи открытого API студии и короткая справка по адресам. */
export function ApiKeys({ rows, clients, base }: { rows: ApiKeyRow[]; clients: { id: string; name: string }[]; base: string }) {
  const { t } = useI18n();
  const a = t.apiKeys;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [client, setClient] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-2 font-semibold">
          <KeyRound className="size-4 text-accent" />
          {a.title}
        </div>
        <p className="text-sm text-muted">{a.hint}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={a.name}>
            <Input className="w-56" value={name} maxLength={100} placeholder="CRM студии" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={a.scope}>
            <Select className="w-44" value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
              <option value="read">{a.read}</option>
              <option value="write">{a.write}</option>
            </Select>
          </Field>
          <Field label={a.client}>
            <Select className="w-56" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">{a.allClients}</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={pending || !name.trim()}
            onClick={() =>
              start(async () => {
                const r = await createApiKey({ name, scope, clientIds: client ? [client] : null });
                if (r.key) {
                  setCreated(r.key);
                  setName("");
                }
              })
            }
          >
            {a.create}
          </Button>
        </div>
        {created && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="font-medium">{a.once}</div>
            <code className="mt-1 block break-all font-mono">{created}</code>
          </div>
        )}
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-mono text-xs text-muted">{r.prefix}…</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <Badge tone={r.scope === "write" ? "warning" : "neutral"}>{r.scope === "write" ? a.write : a.read}</Badge>
              <span className="text-xs text-muted">{r.clients}</span>
              <span className="text-xs text-muted">{r.lastUsedAt ? `${a.used} ${r.lastUsedAt}` : a.never}</span>
              {r.revoked ? (
                <Badge>{a.revoked}</Badge>
              ) : (
                <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => confirm(a.revokeConfirm) && start(() => revokeApiKey(r.id))}>
                  {a.revoke}
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card className="space-y-2 p-5 text-sm">
        <div className="font-semibold">{a.docs}</div>
        <p className="text-muted">{a.docsHint}</p>
        <pre className="overflow-x-auto rounded-lg bg-surface-2/60 p-3 font-mono text-xs leading-relaxed">{`curl -H "Authorization: Bearer ga_live_…" ${base}/api/v1/clients

GET  /api/v1/clients
GET  /api/v1/agents?client_id=…
GET  /api/v1/conversations?client_id=…&updated_since=2026-10-01T00:00:00Z&status=open&limit=50
GET  /api/v1/conversations/{id}
POST /api/v1/conversations/{id}/messages   {"text":"…"}   (write)
GET  /api/v1/usage?month=2026-10&client_id=…`}</pre>
      </Card>
    </div>
  );
}
