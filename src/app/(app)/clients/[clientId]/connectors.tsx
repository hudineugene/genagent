"use client";

import { useState, useTransition } from "react";
import { Plug, Plus, Trash2 } from "lucide-react";
import { saveConnector, testConnector, type ConnectorInput } from "@/app/actions/connectors";
import { deleteTool } from "@/app/actions/tools";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";

export type ConnectorRow = {
  id: string;
  kind: "crm" | "mcp";
  title: string;
  name: string;
  enabled: boolean;
  provider: string;
  domain: string;
  url: string;
  /** Замаскированные секреты: ключ, секрет, вебхук Bitrix24, токен MCP */
  keyMask: string;
  secretMask: string;
  webhookMask: string;
  tokenMask: string;
  pushLeads: boolean;
  lastStatus: string | null;
  usedBy: string[];
};

const PROVIDERS = ["keycrm", "bitrix24", "hubspot", "shopify", "woocommerce"] as const;

/** Готовые подключения: CRM и магазины, MCP-серверы. Агенту их включают в конструкторе, как свои инструменты. */
export function ConnectorsManager({ clientId, rows }: { clientId: string; rows: ConnectorRow[] }) {
  const { t } = useI18n();
  const c = t.connectors;
  const [editing, setEditing] = useState<ConnectorRow | "new-crm" | "new-mcp" | null>(null);
  return (
    <Card className="space-y-4 p-5">
      <div>
        <div className="flex items-center gap-2 font-semibold">
          <Plug className="size-4 text-accent" />
          {c.title}
        </div>
        <p className="text-sm text-muted">{c.hint}</p>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3 text-sm">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              {r.title}
              <Badge tone={r.kind === "mcp" ? "accent" : "neutral"}>{r.kind === "mcp" ? "MCP" : (c.providers as Record<string, string>)[r.provider]}</Badge>
              {!r.enabled && <Badge>{c.off}</Badge>}
              {r.pushLeads && <Badge tone="success">{c.pushLeadsOn}</Badge>}
            </div>
            <div className="text-xs text-muted">
              {r.lastStatus ? `${c.last}: ${r.lastStatus}` : c.never}
              {r.usedBy.length > 0 && ` · ${c.usedBy}: ${r.usedBy.join(", ")}`}
            </div>
          </div>
          <TestButton id={r.id} />
          <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
            {c.edit}
          </Button>
          <DeleteButton id={r.id} />
        </div>
      ))}
      {editing ? (
        <ConnectorForm clientId={clientId} row={typeof editing === "string" ? null : editing} kind={typeof editing === "string" ? (editing === "new-mcp" ? "mcp" : "crm") : editing.kind} onDone={() => setEditing(null)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditing("new-crm")}>
            <Plus className="size-4" />
            {c.addCrm}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing("new-mcp")}>
            <Plus className="size-4" />
            {c.addMcp}
          </Button>
        </div>
      )}
    </Card>
  );
}

function TestButton({ id }: { id: string }) {
  const { t } = useI18n();
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => setRes(await testConnector(id)))}>
        {t.connectors.test}
      </Button>
      {res && <span className={res.ok ? "max-w-64 truncate text-xs text-success" : "max-w-64 truncate text-xs text-danger"} title={res.text}>{res.ok ? `✓ ${res.text}` : res.text}</span>}
    </span>
  );
}

function DeleteButton({ id }: { id: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => confirm(t.common.confirmDelete) && start(() => deleteTool(id))}>
      <Trash2 className="size-4" />
    </Button>
  );
}

function ConnectorForm({ clientId, row, kind, onDone }: { clientId: string; row: ConnectorRow | null; kind: "crm" | "mcp"; onDone: () => void }) {
  const { t } = useI18n();
  const c = t.connectors;
  const [v, setV] = useState({
    title: row?.title ?? (kind === "mcp" ? "" : "CRM"),
    name: row?.name ?? (kind === "mcp" ? "mcp" : "crm"),
    enabled: row?.enabled ?? true,
    provider: (row?.provider || "keycrm") as (typeof PROVIDERS)[number],
    domain: row?.domain ?? "",
    url: row?.url ?? "",
    pushLeads: row?.pushLeads ?? false,
    key: "",
    secret: "",
    webhook: "",
    token: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV({ ...v, [k]: val });
  const p = v.provider;
  const secretInput = (k: "key" | "secret" | "webhook" | "token", label: string, mask: string | undefined, hint?: string) => (
    <Field label={label} hint={mask ? c.keep : hint}>
      <Input className="w-96 max-w-full" type="password" autoComplete="off" value={v[k]} placeholder={mask || ""} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 p-4">
      <div className="flex flex-wrap gap-3">
        <Field label={c.name}>
          <Input className="w-56" value={v.title} maxLength={100} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label={c.prefix} hint={c.prefixHint}>
          <Input className="w-40 font-mono" value={v.name} maxLength={25} onChange={(e) => set("name", e.target.value.toLowerCase())} />
        </Field>
        {kind === "crm" && (
          <Field label={c.system}>
            <Select className="w-52" value={p} onChange={(e) => set("provider", e.target.value as typeof p)}>
              {PROVIDERS.map((x) => (
                <option key={x} value={x}>
                  {(c.providers as Record<string, string>)[x]}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {kind === "mcp" ? (
        <div className="flex flex-wrap gap-3">
          <Field label={c.mcpUrl} hint={c.mcpUrlHint}>
            <Input className="w-96 max-w-full" value={v.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => set("url", e.target.value)} />
          </Field>
          {secretInput("token", c.mcpToken, row?.tokenMask, c.mcpTokenHint)}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {p === "bitrix24" && secretInput("webhook", c.bitrixWebhook, row?.webhookMask, c.bitrixHint)}
          {(p === "shopify" || p === "woocommerce") && (
            <Field label={c.domain}>
              <Input className="w-64" value={v.domain} placeholder={p === "shopify" ? "shop.myshopify.com" : "shop.com.ua"} onChange={(e) => set("domain", e.target.value)} />
            </Field>
          )}
          {p !== "bitrix24" && secretInput("key", (c.keyLabel as Record<string, string>)[p], row?.keyMask)}
          {p === "woocommerce" && secretInput("secret", c.wooSecret, row?.secretMask)}
        </div>
      )}
      {kind === "crm" && <p className="text-xs text-muted">{(c.where as Record<string, string>)[p]}</p>}
      {kind === "crm" && (p === "keycrm" || p === "bitrix24" || p === "hubspot") && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={v.pushLeads} onChange={(e) => set("pushLeads", e.target.checked)} />
          <span>
            <span className="font-medium">{c.pushLeads}</span>
            <span className="block text-xs text-muted">{c.pushLeadsHint}</span>
          </span>
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        {c.enabled}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const input: ConnectorInput = { kind, ...v };
              const r = await saveConnector(clientId, row?.id ?? null, input);
              if (r.error) setError((c.errors as Record<string, string>)[r.error] ?? r.error);
              else onDone();
            })
          }
        >
          {t.common.save}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t.common.cancel}
        </Button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </div>
  );
}
