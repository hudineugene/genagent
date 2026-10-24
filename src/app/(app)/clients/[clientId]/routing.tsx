"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus, Route, Trash2 } from "lucide-react";
import { deleteRoutingRule, saveRoutingRule } from "@/app/actions/routing";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, EmptyState, Field, Input, Textarea } from "@/components/ui";
import { ask } from "@/components/confirm-dialog";

export type RuleRow = { id: string; name: string; description: string; chatIds: string[] };
export type Person = { chatId: string; name: string; kind: "studio" | "owner" };
type Draft = Omit<RuleRow, "id">;

export function RoutingManager({ clientId, rules, people }: { clientId: string; rules: RuleRow[]; people: Person[] }) {
  const { t } = useI18n();
  const r = t.routing;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const label = (chatId: string) => people.find((p) => p.chatId === chatId)?.name ?? r.gone;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{r.subtitle}</p>
      {people.length === 0 && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">{r.noPeople}</p>}
      {editing !== "new" && people.length > 0 && (
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {r.new}
        </Button>
      )}
      {editing === "new" && <RuleEditor clientId={clientId} people={people} initial={{ name: "", description: "", chatIds: [] }} onDone={() => setEditing(null)} />}
      {rules.length === 0 && editing !== "new" && <EmptyState icon={<Route />} text={r.empty} action={<Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" />{r.new}</Button>} />}
      {rules.map((x) =>
        editing === x.id ? (
          <RuleEditor key={x.id} clientId={clientId} id={x.id} people={people} initial={x} onDone={() => setEditing(null)} />
        ) : (
          <Card key={x.id} className="flex flex-wrap items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{x.name}</div>
              {x.description && <p className="mt-0.5 text-sm text-muted">{x.description}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {x.chatIds.map((c) => (
                  <Badge key={c} tone="neutral">
                    {label(c)}
                  </Badge>
                ))}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(x.id)}>
              <Pencil className="size-4" />
            </Button>
            <DeleteRule id={x.id} />
          </Card>
        ),
      )}
      {rules.length > 0 && <p className="text-xs text-muted">{r.fallback}</p>}
    </div>
  );
}

function DeleteRule({ id }: { id: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={async () => await ask(t.routing.confirmDelete) && start(() => deleteRoutingRule(id))}>
      <Trash2 className="size-4" />
    </Button>
  );
}

function RuleEditor({ clientId, id, people, initial, onDone }: { clientId: string; id?: string; people: Person[]; initial: Draft; onDone: () => void }) {
  const { t } = useI18n();
  const r = t.routing;
  const [d, setD] = useState<Draft>({ name: initial.name, description: initial.description, chatIds: initial.chatIds });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (chatId: string) => setD({ ...d, chatIds: d.chatIds.includes(chatId) ? d.chatIds.filter((c) => c !== chatId) : [...d.chatIds, chatId] });
  return (
    <Card className="space-y-3 p-5">
      <Field label={r.name}>
        <Input value={d.name} maxLength={80} placeholder={r.namePlaceholder} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </Field>
      <Field label={r.description} hint={r.descriptionHint}>
        <Textarea rows={2} value={d.description} maxLength={500} placeholder={r.descriptionPlaceholder} onChange={(e) => setD({ ...d, description: e.target.value })} />
      </Field>
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium">{r.who}</div>
        {people.map((p) => (
          <label key={p.chatId} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={d.chatIds.includes(p.chatId)} onChange={() => toggle(p.chatId)} />
            {p.name} <span className="text-xs text-muted">· {r.kinds[p.kind]}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !d.name.trim()}
          onClick={() =>
            start(async () => {
              const res = await saveRoutingRule(clientId, id ?? null, d);
              if (res.error) setError((r.errors as Record<string, string>)[res.error] ?? res.error);
              else onDone();
            })
          }
        >
          {r.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {r.cancel}
        </Button>
      </div>
    </Card>
  );
}
