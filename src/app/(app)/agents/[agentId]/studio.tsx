"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Check, History, Save, Trash2 } from "lucide-react";
import { deleteAgent, saveAgent } from "@/app/actions/agents";
import type { AgentConfig } from "@/lib/agent/types";
import type { ClientContext } from "@/lib/agent/compile";
import { useI18n } from "@/lib/i18n/client";
import { Button, Input, Select, Spinner, cx } from "@/components/ui";
import { Builder } from "./builder";
import { Playground } from "./playground";
import { VersionsPanel } from "./versions";
import type { BuilderSource } from "./builder";

type Status = "draft" | "active" | "paused";

export type StudioAgent = { id: string; name: string; status: Status; version: number; config: AgentConfig };

export function AgentStudio({
  agent,
  client,
  sources,
  googleEmail,
}: {
  agent: StudioAgent;
  client: ClientContext & { id: string };
  sources: BuilderSource[];
  googleEmail: string | null;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(agent.name);
  const [status, setStatus] = useState<Status>(agent.status);
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [version, setVersion] = useState(agent.version);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify({ name, status, config }));
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const snapshot = useMemo(() => JSON.stringify({ name, status, config }), [name, status, config]);
  const dirty = snapshot !== savedSnapshot;

  const save = () =>
    startSave(async () => {
      setError(null);
      try {
        const res = await saveAgent(agent.id, { name, status, config });
        setVersion(res.version);
        setSavedSnapshot(snapshot);
        setNotice(null);
        setJustSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setJustSaved(false), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  // Ctrl/Cmd+S — сохранить
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-surface-2 text-2xl">{config.icon}</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-11 w-auto min-w-48 max-w-md flex-1 border-transparent bg-transparent text-xl font-semibold hover:border-border"
          aria-label={t.builder.name}
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={() => setHistoryOpen(true)} title={t.versions.title}>
            <History className="size-4" />
            <span className="hidden sm:inline">{t.versions.open}</span>
            <span className="text-xs text-muted">v{version}</span>
          </Button>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className="w-36"
            aria-label={t.builder.status}
          >
            {(["draft", "active", "paused"] as const).map((s) => (
              <option key={s} value={s}>
                {t.status[s]}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            title={t.builder.deleteAgent}
            disabled={deleting}
            onClick={() => {
              if (confirm(t.common.confirmDelete)) startDelete(() => deleteAgent(agent.id));
            }}
          >
            {deleting ? <Spinner /> : <Trash2 className="size-4" />}
          </Button>
          <Button onClick={save} disabled={!dirty || saving} className={cx(dirty && "ring-4 ring-accent/20")}>
            {saving ? <Spinner /> : justSaved && !dirty ? <Check className="size-4" /> : <Save className="size-4" />}
            {saving ? t.common.saving : justSaved && !dirty ? t.common.saved : t.common.save}
          </Button>
        </div>
      </div>
      {dirty && <p className="-mt-3 mb-4 text-xs text-amber-600 dark:text-amber-400">{t.builder.unsaved}</p>}
      {error && <p className="-mt-3 mb-4 text-sm text-danger">{error}</p>}
      {notice && dirty && <p className="-mt-2 mb-4 text-sm text-accent">{notice}</p>}

      {historyOpen && (
        <VersionsPanel
          agentId={agent.id}
          currentVersion={version}
          current={{ name, config }}
          sources={sources}
          onClose={() => setHistoryOpen(false)}
          onRestore={(v) => {
            if (v.name) setName(v.name);
            setConfig(v.config);
            setNotice(t.versions.restored);
            setHistoryOpen(false);
          }}
        />
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
        <Builder config={config} onChange={setConfig} client={client} sources={sources} googleEmail={googleEmail} />
        <div className="xl:sticky xl:top-6 xl:h-[calc(100dvh-3rem)]">
          <Playground clientId={client.id} config={config} />
        </div>
      </div>
    </div>
  );
}
