"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Check, History, RotateCcw, Save, Trash2 } from "lucide-react";
import { deleteAgent, saveAgent } from "@/app/actions/agents";
import type { AgentConfig } from "@/lib/agent/types";
import type { ClientContext } from "@/lib/agent/compile";
import { useI18n } from "@/lib/i18n/client";
import { Button, Input, Select, Spinner, cx } from "@/components/ui";
import { BUILDER_GROUPS, Builder, BuilderGroupContext, groupOf, type BuilderGroup } from "./builder";
import { Playground } from "./playground";
import { VersionsPanel } from "./versions";
import type { BuilderDocTemplate, BuilderProgram, BuilderTable, BuilderForm, BuilderProcedure, BuilderSource, BuilderTool, ExampleItem } from "./builder";

type Status = "draft" | "active" | "paused";

export type StudioAgent = { id: string; name: string; status: Status; version: number; config: AgentConfig };

type Saved = { name: string; status: Status; config: AgentConfig };

export function AgentStudio({
  agent,
  client,
  sources,
  googleEmail,
  examples,
  tools,
  forms,
  procedures,
  docTemplates,
  tables,
  programs,
}: {
  agent: StudioAgent;
  client: ClientContext & { id: string };
  sources: BuilderSource[];
  googleEmail: string | null;
  examples: ExampleItem[];
  tools: BuilderTool[];
  forms: BuilderForm[];
  procedures: BuilderProcedure[];
  docTemplates: BuilderDocTemplate[];
  tables: BuilderTable[];
  programs: BuilderProgram[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [status, setStatus] = useState<Status>(agent.status);
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [version, setVersion] = useState(agent.version);
  const [saved, setSaved] = useState<Saved>(() => ({ name: agent.name, status: agent.status, config: agent.config }));
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<BuilderGroup>("profile");
  // Ссылка вида /agents/<id>#rules или #abilities открывает нужный экран настроек
  useEffect(() => {
    const open = () => {
      const h = window.location.hash.slice(1);
      const g = h in BUILDER_GROUPS ? (h as BuilderGroup) : groupOf(h);
      if (g) setGroup(g);
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const snapshot = useMemo(() => JSON.stringify({ name, status, config }), [name, status, config]);
  const savedSnapshot = useMemo(() => JSON.stringify(saved), [saved]);
  const dirty = snapshot !== savedSnapshot;

  const save = () =>
    startSave(async () => {
      setError(null);
      try {
        const res = await saveAgent(agent.id, { name, status, config });
        setVersion(res.version);
        setSaved({ name, status, config });
        setNotice(null);
        setJustSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setJustSaved(false), 2500);
        // Шапка агента (название, статус, версия) — свежая
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  const discard = () => {
    setName(saved.name);
    setStatus(saved.status);
    setConfig(saved.config);
    setNotice(null);
    setError(null);
  };

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

  // Уходят со страницы с несохранёнными изменениями — браузер переспросит
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  return (
    <div>
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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]">
        <div className="min-w-0">
          {/* Название и статус — то, что раньше было в шапке страницы */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t.agentHeader.name} title={t.agentHeader.name} className="min-w-48 flex-1" />
            <label>
              <Select value={status} onChange={(e) => setStatus(e.target.value as Status)} className="w-36" aria-label={t.builder.status} title={t.builder.status}>
                {(["draft", "active", "paused"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t.status[s]}
                  </option>
                ))}
              </Select>
            </label>
            <Button variant="ghost" onClick={() => setHistoryOpen(true)} title={t.versions.title}>
              <History className="size-4" />
              <span className="text-xs text-muted">v{version}</span>
            </Button>
            <Button
              variant="ghost"
              title={t.builder.deleteAgent}
              className="hover:text-danger"
              disabled={deleting}
              onClick={() => {
                if (confirm(t.common.confirmDelete)) startDelete(() => deleteAgent(agent.id));
              }}
            >
              {deleting ? <Spinner /> : <Trash2 className="size-4" />}
            </Button>
            {justSaved && !dirty && (
              <span className="flex h-10 items-center gap-1.5 text-sm font-medium text-success">
                <Check className="size-4" />
                {t.common.saved}
              </span>
            )}
          </div>

          <GroupNav group={group} onChange={setGroup} config={config} />

          <BuilderGroupContext.Provider value={group}>
          <Builder config={config} onChange={setConfig} client={client} sources={sources} googleEmail={googleEmail} agentId={agent.id} examples={examples} tools={tools} forms={forms} procedures={procedures} docTemplates={docTemplates} tables={tables} programs={programs} />
          </BuilderGroupContext.Provider>

          {/* Панель сохранения — только когда есть изменения, прилипает к низу экрана */}
          {(dirty || error) && (
            <div className="sticky bottom-4 z-20 mt-4">
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-xl shadow-black/10 backdrop-blur">
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500" />
                <div className="min-w-0 flex-1 text-sm">
                  {error ? <span className="text-danger">{error}</span> : <span className="font-medium">{t.agentHeader.unsavedBar}</span>}
                  {notice && !error && <span className="ml-2 text-accent">{notice}</span>}
                </div>
                <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
                  <RotateCcw className="size-4" />
                  {t.agentHeader.discard}
                </Button>
                <Button size="sm" onClick={save} disabled={!dirty || saving}>
                  {saving ? <Spinner /> : <Save className="size-4" />}
                  {saving ? t.common.saving : t.common.save}
                  <kbd className="ml-1 hidden rounded bg-white/20 px-1 text-[10px] font-medium sm:inline">{t.agentHeader.saveHint}</kbd>
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="xl:sticky xl:top-6 xl:h-[calc(100dvh-3rem)]">
          <Playground clientId={client.id} config={config} />
        </div>
      </div>
    </div>
  );
}

/** Экраны настроек агента — вкладки над формой; счётчик у «Возможностей» — сколько модулей включено. */
function GroupNav({ group, onChange, config }: { group: BuilderGroup; onChange: (g: BuilderGroup) => void; config: AgentConfig }) {
  const { t } = useI18n();
  const abilities =
    (config.calendar.enabled ? 1 : 0) +
    (config.toolIds?.length || config.webSearch ? 1 : 0) +
    (config.formIds?.length ? 1 : 0) +
    (config.docTemplateIds?.length ? 1 : 0) +
    (config.tableIds?.length ? 1 : 0) +
    (config.loyaltyProgramId || config.logistics ? 1 : 0) +
    (config.team?.enabled ? 1 : 0);
  return (
    <nav aria-label={t.agentHeader.sectionsNav} className="sticky top-0 z-10 -mx-1 mb-4 overflow-x-auto bg-bg/90 px-1 py-2 backdrop-blur [scrollbar-width:none]">
      <div className="flex gap-1 rounded-xl border border-border bg-surface p-1">
        {(Object.keys(BUILDER_GROUPS) as BuilderGroup[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => {
              onChange(g);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className={cx(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition",
              group === g ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {t.builder.groups[g]}
            {g === "abilities" && abilities > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-4 text-accent-text">{abilities}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}
