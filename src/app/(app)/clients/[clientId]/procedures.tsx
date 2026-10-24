"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from "lucide-react";
import { deleteProcedure, saveProcedure, type ProcedureInput } from "@/app/actions/procedures";
import type { ProcedureStep } from "@/db/schema";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";

export type ProcedureRow = { id: string; name: string; trigger: string; steps: ProcedureStep[]; enabled: boolean; usedBy: string[] };
export type ToolOption = { id: string; title: string; kind: string; params: string[] };

const KINDS = ["ask", "tool", "approval", "say", "handoff"] as const;
const TYPES = ["text", "phone", "email", "number", "date", "choice"] as const;

const blank = (kind: ProcedureStep["kind"]): ProcedureStep =>
  kind === "ask"
    ? { kind, key: "", question: "", type: "text" }
    : kind === "tool"
      ? { kind, toolId: "", args: {}, saveAs: "result" }
      : kind === "approval"
        ? { kind, subject: "", details: "", rejected: "" }
        : { kind, text: "" };

/** Процедуры с обязательными шагами: агент запускает, программа ведёт клиента дословно. */
export function ProceduresManager({ clientId, rows, tools }: { clientId: string; rows: ProcedureRow[]; tools: ToolOption[] }) {
  const { t } = useI18n();
  const p = t.procedures;
  const [editing, setEditing] = useState<ProcedureRow | "new" | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{p.subtitle}</p>
      {rows.map((r) => (
        <Card key={r.id} className="flex flex-wrap items-center gap-3 p-4">
          <ListChecks className="size-5 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              {r.name}
              {!r.enabled && <Badge>{p.off}</Badge>}
              <Badge tone="neutral">{p.stepsCount.replace("{n}", String(r.steps.length))}</Badge>
            </div>
            <div className="truncate text-sm text-muted">{r.trigger}</div>
            <div className="text-xs text-muted">{r.usedBy.length ? `${p.usedBy}: ${r.usedBy.join(", ")}` : p.unused}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
            {p.edit}
          </Button>
          <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => confirm(t.common.confirmDelete) && start(() => deleteProcedure(r.id))}>
            <Trash2 className="size-4" />
          </Button>
        </Card>
      ))}
      {editing ? (
        <Editor clientId={clientId} row={editing === "new" ? null : editing} tools={tools} onDone={() => setEditing(null)} />
      ) : (
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          {p.add}
        </Button>
      )}
    </div>
  );
}

function Editor({ clientId, row, tools, onDone }: { clientId: string; row: ProcedureRow | null; tools: ToolOption[]; onDone: () => void }) {
  const { t } = useI18n();
  const p = t.procedures;
  const [name, setName] = useState(row?.name ?? "");
  const [trigger, setTrigger] = useState(row?.trigger ?? "");
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [steps, setSteps] = useState<ProcedureStep[]>(row?.steps ?? [blank("ask")]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const upd = (i: number, s: ProcedureStep) => setSteps(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: number) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setSteps(next);
  };
  const keys = steps.flatMap((s) => (s.kind === "ask" ? [s.key] : s.kind === "tool" ? [s.saveAs] : [])).filter(Boolean);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap gap-3">
        <Field label={p.name}>
          <Input className="w-64" value={name} maxLength={100} placeholder={p.namePlaceholder} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={p.trigger} hint={p.triggerHint}>
          <Input className="w-[28rem] max-w-full" value={trigger} maxLength={500} placeholder={p.triggerPlaceholder} onChange={(e) => setTrigger(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-muted">{p.keysHint.replace("{keys}", keys.length ? keys.map((k) => `{${k}}`).join(", ") : "—")}</p>
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{i + 1}.</span>
              <Select className="h-8 w-56 text-[13px]" value={s.kind} onChange={(e) => upd(i, blank(e.target.value as ProcedureStep["kind"]))}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {p.kinds[k]}
                  </option>
                ))}
              </Select>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            {s.kind === "ask" && (
              <div className="flex flex-wrap gap-2">
                <Textarea rows={2} className="min-w-72 flex-1" value={s.question} placeholder={p.question} onChange={(e) => upd(i, { ...s, question: e.target.value })} />
                <Select className="w-40" value={s.type} onChange={(e) => upd(i, { ...s, type: e.target.value as (typeof TYPES)[number] })}>
                  {TYPES.map((x) => (
                    <option key={x} value={x}>
                      {p.types[x]}
                    </option>
                  ))}
                </Select>
                <Input className="w-40 font-mono" value={s.key} placeholder={p.key} onChange={(e) => upd(i, { ...s, key: e.target.value.toLowerCase() })} />
                {s.type === "choice" && (
                  <Input className="w-full" value={(s.options ?? []).join("; ")} placeholder={p.options} onChange={(e) => upd(i, { ...s, options: e.target.value.split(";").map((x) => x.trim()).filter(Boolean) })} />
                )}
              </div>
            )}
            {s.kind === "tool" && (
              <div className="flex flex-wrap gap-2">
                <Select className="w-64" value={s.toolId} onChange={(e) => upd(i, { ...s, toolId: e.target.value, args: {} })}>
                  <option value="">{p.pickTool}</option>
                  {tools.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title}
                    </option>
                  ))}
                </Select>
                {tools.find((x) => x.id === s.toolId)?.kind === "crm" && (
                  <Select className="w-48" value={s.action ?? "order"} onChange={(e) => upd(i, { ...s, action: e.target.value as "find" | "order" })}>
                    <option value="order">{p.crmOrder}</option>
                    <option value="find">{p.crmFind}</option>
                  </Select>
                )}
                {(tools.find((x) => x.id === s.toolId)?.params ?? []).map((param) => (
                  <Input key={param} className="w-48" value={s.args[param] ?? ""} placeholder={`${param} = {…}`} onChange={(e) => upd(i, { ...s, args: { ...s.args, [param]: e.target.value } })} />
                ))}
                <Input className="w-40 font-mono" value={s.saveAs} placeholder={p.saveAs} onChange={(e) => upd(i, { ...s, saveAs: e.target.value.toLowerCase() })} />
              </div>
            )}
            {s.kind === "approval" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input value={s.subject} placeholder={p.subject} onChange={(e) => upd(i, { ...s, subject: e.target.value })} />
                <Input value={s.amount ?? ""} placeholder={p.amount} onChange={(e) => upd(i, { ...s, amount: e.target.value })} />
                <Textarea rows={2} value={s.details} placeholder={p.details} onChange={(e) => upd(i, { ...s, details: e.target.value })} />
                <Textarea rows={2} value={s.rejected} placeholder={p.rejected} onChange={(e) => upd(i, { ...s, rejected: e.target.value })} />
              </div>
            )}
            {(s.kind === "say" || s.kind === "handoff") && <Textarea rows={2} value={s.text} placeholder={s.kind === "say" ? p.say : p.handoff} onChange={(e) => upd(i, { ...s, text: e.target.value })} />}
          </li>
        ))}
      </ol>
      <Button size="sm" variant="secondary" onClick={() => setSteps([...steps, blank("ask")])}>
        <Plus className="size-4" />
        {p.addStep}
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {p.enabled}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              const input: ProcedureInput = { name, trigger, steps, enabled };
              const r = await saveProcedure(clientId, row?.id ?? null, input);
              if (r.error) setError((p.errors as Record<string, string>)[r.error] ?? r.error);
              else onDone();
            })
          }
        >
          {t.common.save}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t.common.cancel}
        </Button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    </Card>
  );
}
