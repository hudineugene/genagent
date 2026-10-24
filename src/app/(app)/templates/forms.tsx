"use client";

import { useMemo, useState, useTransition } from "react";
import { pushTemplateAction, saveAsTemplateAction } from "@/app/actions/studio-templates";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Card, Field, Input, Select } from "@/components/ui";

/** Шаблон из агента: новый или новая версия существующего. */
export function SaveAsTemplate({ agents, templates }: { agents: { id: string; label: string }[]; templates: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const s = t.studioTemplates;
  const [agentId, setAgentId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card className="space-y-3 p-5">
      <div className="font-semibold">{s.fromAgent}</div>
      <p className="text-sm text-muted">{s.fromAgentHint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={s.agent}>
          <Select className="w-72" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">—</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={s.target}>
          <Select
            className="w-56"
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setName(templates.find((x) => x.id === e.target.value)?.name ?? name);
            }}
          >
            <option value="">{s.newTemplate}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {s.newVersionOf} «{x.name}»
              </option>
            ))}
          </Select>
        </Field>
        <Field label={s.name}>
          <Input className="w-56" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={s.description}>
          <Input className="w-72" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Button
          disabled={pending || !agentId || !name.trim()}
          onClick={() =>
            start(async () => {
              const r = await saveAsTemplateAction(agentId, { name, description, templateId: templateId || null });
              setMsg(r.error ? s.error : s.saved);
            })
          }
        >
          {t.common.save}
        </Button>
        {msg && <span className="text-sm text-muted">{msg}</span>}
      </div>
    </Card>
  );
}

type Linked = { id: string; name: string; client: string; version: number; diff: string[] };

/** Раскатка версии: какие агенты и какие поля. По умолчанию — отставшие агенты и все отличающиеся поля. */
export function PushForm({ templateId, version, agents, disabled, fieldLabels }: { templateId: string; version: number; agents: Linked[]; disabled: boolean; fieldLabels: Record<string, string> }) {
  const { t } = useI18n();
  const s = t.studioTemplates;
  const allDiff = useMemo(() => [...new Set(agents.flatMap((a) => a.diff))], [agents]);
  const [picked, setPicked] = useState<string[]>(agents.filter((a) => a.version < version && a.diff.length).map((a) => a.id));
  const [fields, setFields] = useState<string[]>(allDiff);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (list: string[], set: (l: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {agents.map((a) => (
          <label key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" disabled={disabled} checked={picked.includes(a.id)} onChange={() => toggle(picked, setPicked, a.id)} />
            <span className="font-medium">{a.name}</span>
            <span className="text-muted">· {a.client}</span>
            <Badge tone={a.version < version ? "warning" : "success"}>v{a.version}</Badge>
            <span className="text-xs text-muted">{a.diff.length ? `${s.differs}: ${a.diff.map((f) => fieldLabels[f] ?? f).join(", ")}` : s.same}</span>
          </label>
        ))}
      </div>
      {allDiff.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted">{s.fieldsToPush}</div>
          <div className="flex flex-wrap gap-2">
            {allDiff.map((f) => (
              <label key={f} className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs">
                <input type="checkbox" className="size-3.5 accent-[var(--accent)]" disabled={disabled} checked={fields.includes(f)} onChange={() => toggle(fields, setFields, f)} />
                {fieldLabels[f] ?? f}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={disabled || pending || !picked.length}
          onClick={() =>
            start(async () => {
              const r = await pushTemplateAction(templateId, picked, fields);
              setMsg(r.error ? s.error : s.pushed.replace("{n}", String(r.updated ?? 0)));
            })
          }
        >
          {s.push.replace("{n}", String(picked.length))}
        </Button>
        <span className="text-xs text-muted">{s.pushHint}</span>
        {msg && <span className="text-sm text-success">{msg}</span>}
      </div>
    </div>
  );
}
