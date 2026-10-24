"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, ChevronDown, Download, ExternalLink, GitCompare, Layers, Loader2, Route, Wand2, X } from "lucide-react";
import { saveAgent } from "@/app/actions/agents";
import type { AgentConfig } from "@/lib/agent/types";
import { EFFORTS, REPLY_LANGUAGES, TONES } from "@/lib/agent/types";
import { CHANNEL_LABEL, MODULES, PIPELINE, PRESETS, moduleCost, modulesDiff, toolModule, type Ctx, type Lists, type MapStats, type Mod, type Ready } from "@/lib/agent/map-modules";
import { ADD_KINDS } from "@/lib/channels/add-kinds";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Input, Select, SwitchButton, cx } from "@/components/ui";
import { Dot, MapCanvas, type MapChannel } from "@/components/agent-map/canvas";
import { downloadMapPng } from "@/components/agent-map/export";

type AgentView = { id: string; name: string; status: "draft" | "active" | "paused"; version: number; config: AgentConfig };
type Version = { version: number; at: string; config: AgentConfig };
type Panel = { kind: "core" } | { kind: "mod"; key: string } | { kind: "addChannel" } | null;
type PathResult = { modules: Set<string>; steps: { name: string; error?: boolean }[]; sources: string[]; reply: string; cost: number | null; ms: number | null; error?: string };

export function AgentMap({
  agent,
  clientId,
  channels,
  lists,
  ready,
  models,
  stats,
  versions,
}: {
  agent: AgentView;
  clientId: string;
  channels: MapChannel[];
  lists: Lists;
  ready: Ready;
  models: { id: string; label: string }[];
  stats: MapStats;
  versions: Version[];
}) {
  const { t, locale } = useI18n();
  const uk = locale === "uk";
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [saved, setSaved] = useState<AgentConfig>(agent.config);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();
  const [compare, setCompare] = useState<number | null>(null);
  const [path, setPath] = useState<PathResult | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const ctx: Ctx = { lists, ready, clientId, agentId: agent.id };
  const dirty = JSON.stringify(config) !== JSON.stringify(saved);
  const patch = (p: Partial<AgentConfig>) => setConfig((c) => ({ ...c, ...p }));
  const model = models.find((m) => m.id === config.model)?.label ?? config.model;
  const coreLines = [
    { k: uk ? "Модель" : "Модель", v: model },
    { k: "Тон", v: t.builder.tones[config.tone] },
    { k: uk ? "Мова" : "Язык", v: t.builder.languages[config.replyLanguage] },
    { k: "Роль", v: config.role || "—" },
  ];
  const other = versions.find((v) => v.version === compare);
  const diff = useMemo(() => (other ? modulesDiff(config, other.config) : null), [config, other]);
  const current = panel?.kind === "mod" ? MODULES.find((m) => m.key === panel.key) : undefined;

  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  // Что исправить: включённые модули с жёлтой точкой, каналы со сбоями и без сообщений, пустые основы
  const fixes = useMemo(() => {
    const out: { text: string; action: () => void }[] = [];
    if (channels.length === 0) out.push({ text: uk ? "Немає жодного каналу — клієнти не можуть написати агенту" : "Нет ни одного канала — клиенты не могут написать агенту", action: () => setPanel({ kind: "addChannel" }) });
    if (lists.kb.length === 0 && !config.knowledge.trim()) out.push({ text: uk ? "Немає бази знань і ключових фактів — агенту нема на що спиратися" : "Нет базы знаний и ключевых фактов — агенту не на что опираться", action: () => setPanel({ kind: "mod", key: "kb" }) });
    for (const m of MODULES) {
      const w = m.on(config) ? m.warn?.(config, ctx) : null;
      if (w) out.push({ text: `${m.title[locale]}: ${w[locale]}`, action: () => setPanel({ kind: "mod", key: m.key }) });
    }
    for (const c of channels) {
      const s = stats.channels[c.id];
      if (c.enabled && s?.errors) out.push({ text: `${CHANNEL_LABEL[c.type] ?? c.type} «${c.name}»: ${uk ? `збоїв за 7 днів — ${s.errors}` : `сбоев за 7 дней — ${s.errors}`}`, action: () => router.push(`/agents/${agent.id}/channels`) });
    }
    if (agent.status !== "active") out.push({ text: uk ? "Агент не активний — клієнтам не відповідає" : "Агент не активен — клиентам не отвечает", action: () => router.push(`/agents/${agent.id}#section-basics`) });
    return out;
    // ctx пересобирается каждый рендер, его поля — props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, channels, lists, ready, stats, locale, agent.status]);

  const save = () =>
    start(async () => {
      setError(false);
      try {
        await saveAgent(agent.id, { name: agent.name, status: agent.status, config });
        setSaved(config);
        router.refresh();
      } catch {
        setError(true);
      }
    });

  // Путь ответа: тестовый ответ на текущих (и несохранённых) настройках, инструменты не меняют данные
  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setPath(null);
    const res: PathResult = { modules: new Set(["facts"].filter(() => config.knowledge.trim().length > 0)), steps: [], sources: [], reply: "", cost: null, ms: null };
    try {
      const r = await fetch("/api/playground", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, config, messages: [{ role: "user", content: q }] }) });
      if (!r.ok || !r.body) throw new Error(String(r.status));
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          const ev = JSON.parse(l);
          if (ev.t === "text") res.reply += ev.v;
          else if (ev.t === "tool") {
            res.steps.push({ name: ev.name, error: ev.error });
            res.modules.add(toolModule(ev.name));
          } else if (ev.t === "done") {
            res.cost = ev.cost ?? null;
            res.ms = ev.ms ?? null;
            res.sources = ev.kb?.sources ?? [];
            if (res.sources.length || ev.kb?.mode === "full") res.modules.add("kb");
          } else if (ev.t === "error") res.error = ev.code === "missing_key" ? (uk ? `Немає ключа ${ev.message}` : `Нет ключа ${ev.message}`) : ev.message;
        }
      }
      if (config.memory) res.modules.add("memory");
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
    }
    setPath(res);
    setAsking(false);
  };

  const exportPng = () =>
    void downloadMapPng({ config, agentName: agent.name, coreLines, channels, ctx, locale, fileName: `agent-${agent.name}`.replace(/[^\p{L}\p{N}-]+/gu, "-"), title: agent.name }).catch(() => alert(uk ? "Не вдалося зберегти картинку" : "Не удалось сохранить картинку"));

  return (
    <div className="space-y-4">
      {/* Панель инструментов карты */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFixOpen((v) => !v)}
          className={cx("flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium transition", fixes.length ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-border text-muted")}
        >
          <AlertTriangle className="size-4" />
          {uk ? "Що виправити" : "Что исправить"} · {fixes.length}
          <ChevronDown className={cx("size-3.5 transition", fixOpen && "rotate-180")} />
        </button>
        <Menu icon={Layers} label={uk ? "Набір модулів" : "Набор модулей"}>
          {(close) =>
            PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  patch(p.patch(config));
                  close();
                }}
                className="block w-full rounded-lg px-3 py-2 text-left hover:bg-surface-2"
              >
                <span className="block text-sm font-medium">{p.title[locale]}</span>
                <span className="block text-xs text-muted">{p.desc[locale]}</span>
              </button>
            ))
          }
        </Menu>
        <label className="flex items-center gap-1.5 rounded-xl border border-border px-2 py-1 text-sm">
          <GitCompare className="size-4 text-muted" />
          <select className="bg-transparent outline-none" value={compare ?? ""} onChange={(e) => setCompare(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{uk ? "Порівняти з версією…" : "Сравнить с версией…"}</option>
            {versions
              .filter((v) => v.version !== agent.version)
              .map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {v.at}
                </option>
              ))}
          </select>
        </label>
        <button type="button" onClick={exportPng} className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-muted transition hover:text-text">
          <Download className="size-4" />
          PNG
        </button>
        <Legend uk={uk} />
      </div>

      {fixOpen && (
        <div className="rounded-2xl border border-border bg-surface p-3">
          {fixes.length === 0 ? (
            <p className="text-sm text-muted">{uk ? "Усе налаштовано — виправляти нічого." : "Всё настроено — исправлять нечего."}</p>
          ) : (
            <ul className="space-y-1">
              {fixes.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <Dot state="warn" />
                  <span className="min-w-0 flex-1">{f.text}</span>
                  <button type="button" onClick={f.action} className="shrink-0 text-accent hover:underline">
                    {uk ? "Виправити" : "Исправить"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Путь ответа */}
      <form
        className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <Route className="size-4 shrink-0 text-amber-500" />
        <Input className="min-w-0 flex-1" maxLength={500} placeholder={uk ? "Питання клієнта — подивитися, що спрацює (≈ $0.002, дані не змінюються)" : "Вопрос клиента — посмотреть, что сработает (≈ $0.002, данные не меняются)"} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <Button type="submit" disabled={asking || !question.trim()}>
          {asking ? <Loader2 className="size-4 animate-spin" /> : uk ? "Показати шлях" : "Показать путь"}
        </Button>
        {path && (
          <Button type="button" variant="ghost" onClick={() => setPath(null)}>
            <X className="size-4" />
          </Button>
        )}
        {path && (
          <div className="w-full space-y-1.5 border-t border-border pt-2 text-sm">
            {path.error ? (
              <p className="text-danger">{path.error}</p>
            ) : (
              <>
                <p className="whitespace-pre-wrap">{path.reply.replace(/\[\[[^\]]*\]\]/g, "").trim() || "—"}</p>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {path.sources.slice(0, 6).map((s) => (
                    <Badge key={s}>📄 {s}</Badge>
                  ))}
                  {path.steps.map((s, i) => (
                    <Badge key={i} tone={s.error ? "warning" : "accent"}>
                      🔧 {s.name}
                    </Badge>
                  ))}
                  {path.ms != null && <Badge>{(path.ms / 1000).toFixed(1)} с</Badge>}
                  {path.cost != null && <Badge>${path.cost.toFixed(4)}</Badge>}
                </div>
                <p className="text-xs text-muted">{uk ? "Підсвічено на карті жовтим. Перевірка відповіді й надсилання в тесті не виконуються." : "Подсвечено на карте жёлтым. Проверка ответа и отправка в тесте не выполняются."}</p>
              </>
            )}
          </div>
        )}
      </form>

      {dirty && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/40 bg-surface/95 p-3 shadow-sm backdrop-blur">
          <span className="flex-1 text-sm font-medium">{uk ? "Є незбережені зміни" : "Есть несохранённые изменения"}</span>
          {error && <span className="text-sm text-danger">{uk ? "Не збереглося" : "Не сохранилось"}</span>}
          <Button variant="ghost" disabled={pending} onClick={() => setConfig(saved)}>
            {uk ? "Скасувати" : "Отменить"}
          </Button>
          <Button disabled={pending} onClick={save}>
            {uk ? "Зберегти нову версію" : "Сохранить новую версию"}
          </Button>
        </div>
      )}

      {other && diff && (
        <p className="text-xs text-muted">
          {uk ? `Порівняння з v${other.version}: ` : `Сравнение с v${other.version}: `}
          <span className="text-success">+ {uk ? "увімкнено тепер" : "включено сейчас"}</span> · <span className="text-danger">− {uk ? "було у v" : "было в v"}{other.version}</span>
          {Object.keys(diff).length === 0 && (uk ? " — модулі однакові" : " — модули одинаковые")}
        </p>
      )}

      <MapCanvas
        config={config}
        agentName={agent.name}
        coreLines={coreLines}
        channels={channels}
        ctx={ctx}
        stats={stats}
        highlight={path?.modules ?? null}
        diff={diff}
        selectedKey={panel?.kind === "core" ? "core" : panel?.kind === "mod" ? panel.key : null}
        onSelect={(key) => setPanel(key === "core" ? { kind: "core" } : { kind: "mod", key })}
        onToggle={(m, v) => patch(m.toggle!(config, v))}
        onAddChannel={() => setPanel({ kind: "addChannel" })}
        channelHref={`/agents/${agent.id}/channels`}
        locale={locale}
        coreTitle={uk ? "Ядро агента" : "Ядро агента"}
      />

      {panel && (
        <div role="dialog" className="fixed inset-y-0 right-0 z-40 w-full max-w-sm space-y-4 overflow-y-auto border-l border-border bg-surface p-5 shadow-2xl">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 font-semibold">
              {panel.kind === "core" ? (uk ? "Ядро агента" : "Ядро агента") : panel.kind === "addChannel" ? (uk ? "Підключити канал" : "Подключить канал") : current?.title[locale]}
            </div>
            <button type="button" onClick={() => setPanel(null)} className="text-muted hover:text-text" aria-label="×">
              <X className="size-4" />
            </button>
          </div>
          {panel.kind === "core" && <CorePanel config={config} patch={patch} models={models} agentId={agent.id} uk={uk} />}
          {panel.kind === "mod" && current && <ModulePanel m={current} config={config} patch={patch} ctx={ctx} uk={uk} stats={stats} />}
          {panel.kind === "addChannel" && (
            <div className="grid grid-cols-2 gap-2 text-sm">
              {ADD_KINDS.map((k) => (
                <Link key={k} href={`/agents/${agent.id}/channels?add=${k}`} className="rounded-xl border border-border px-3 py-2 transition hover:border-accent/50">
                  {k === "voice" ? (uk ? "Дзвінки" : "Звонки") : k === "api" ? (uk ? "Свій бот (API)" : "Свой бот (API)") : (CHANNEL_LABEL[k] ?? k)}
                </Link>
              ))}
              <Link href={`/agents/${agent.id}/channels`} className="rounded-xl border border-border px-3 py-2 transition hover:border-accent/50">
                {uk ? "Віджет на сайт" : "Виджет на сайт"}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Menu({ icon: Icon, label, children }: { icon: typeof Layers; label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm transition hover:border-accent/50">
        <Icon className="size-4 text-muted" />
        {label}
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-40 mt-1 w-72 rounded-xl border border-border bg-surface p-1 shadow-xl">{children(() => setOpen(false))}</div>
        </>
      )}
    </div>
  );
}

function Legend({ uk }: { uk: boolean }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <Dot state="on" />
        {uk ? "увімкнено" : "включён"}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot state="warn" />
        {uk ? "чогось бракує" : "чего-то не хватает"}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot state="bad" />
        {uk ? "збої" : "сбои"}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent">7</span>
        {uk ? "спрацювань за 7 днів" : "срабатываний за 7 дней"}
      </span>
    </div>
  );
}

function CorePanel({ config, patch, models, agentId, uk }: { config: AgentConfig; patch: (p: Partial<AgentConfig>) => void; models: { id: string; label: string }[]; agentId: string; uk: boolean }) {
  const { t, locale } = useI18n();
  const list = models.some((m) => m.id === config.model) ? models : [{ id: config.model, label: config.model }, ...models];
  const stepOn = (key?: string) => (key ? (MODULES.find((m) => m.key === key)?.on(config) ?? false) : true);
  return (
    <div className="space-y-3 text-sm">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{uk ? "Модель ШІ" : "Модель ИИ"}</span>
        <Select value={config.model} onChange={(e) => patch({ model: e.target.value })}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted">{uk ? "Глибина" : "Глубина"}</span>
          <Select value={config.effort} onChange={(e) => patch({ effort: e.target.value as AgentConfig["effort"] })}>
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {t.builder.efforts[x]}
              </option>
            ))}
          </Select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted">Тон</span>
          <Select value={config.tone} onChange={(e) => patch({ tone: e.target.value as AgentConfig["tone"] })}>
            {TONES.map((x) => (
              <option key={x} value={x}>
                {t.builder.tones[x]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{uk ? "Мова відповідей" : "Язык ответов"}</span>
        <Select value={config.replyLanguage} onChange={(e) => patch({ replyLanguage: e.target.value as AgentConfig["replyLanguage"] })}>
          {REPLY_LANGUAGES.map((x) => (
            <option key={x} value={x}>
              {t.builder.languages[x]}
            </option>
          ))}
        </Select>
      </label>
      <Link href={`/agents/${agentId}#section-basics`} className="inline-flex items-center gap-1 text-accent hover:underline">
        {uk ? "Роль, правила й інструкції" : "Роль, правила и инструкции"}
        <ExternalLink className="size-3.5" />
      </Link>
      <div className="border-t border-border pt-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted">
          <Wand2 className="size-3.5" />
          {uk ? "Як програма обробляє повідомлення" : "Как программа обрабатывает сообщение"}
        </div>
        <ol className="space-y-1.5">
          {PIPELINE.map((s, i) => {
            const on = stepOn(s.module);
            return (
              <li key={i} className={cx("flex gap-2", !on && "opacity-50")}>
                <span className={cx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold", on ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted")}>{i + 1}</span>
                <span className="min-w-0">
                  <span className="block font-medium">
                    {s.title[locale]}
                    {s.module && !on && <span className="ml-1 text-xs font-normal text-muted">· {uk ? "вимкнено" : "выключено"}</span>}
                  </span>
                  <span className="block text-xs text-muted">{s.desc[locale]}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function ModulePanel({ m, config, patch, ctx, uk, stats }: { m: Mod; config: AgentConfig; patch: (p: Partial<AgentConfig>) => void; ctx: Ctx; uk: boolean; stats: MapStats }) {
  const locale = uk ? "uk" : "ru";
  const warn = m.on(config) ? m.warn?.(config, ctx) : null;
  const items = m.pick ? ctx.lists[m.pick.list] : m.key === "kb" ? ctx.lists.kb : m.key === "loyalty" ? ctx.lists.programs : [];
  const selectedIds: string[] = m.pick ? (config[m.pick.field] ?? []) : [];
  const used = stats.modules[m.key];
  const cost = moduleCost(m.key, stats);
  const setPick = (id: string, on: boolean) => {
    if (!m.pick) return;
    const next = on ? [...selectedIds, id] : selectedIds.filter((x) => x !== id);
    patch({ [m.pick.field]: next } as Partial<AgentConfig>);
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">{m.desc[locale]}</p>
      {warn && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">{warn[locale]}</p>}
      {m.toggle && (
        <div className="flex items-center gap-3">
          <span className="flex-1 font-medium">{m.on(config) ? (uk ? "Увімкнено" : "Включено") : uk ? "Вимкнено" : "Выключено"}</span>
          <SwitchButton checked={m.on(config)} onChange={(v) => patch(m.toggle!(config, v))} />
        </div>
      )}
      <div className="grid gap-1 rounded-lg bg-surface-2/60 px-3 py-2 text-xs">
        <span>
          {uk ? "За 7 днів: " : "За 7 дней: "}
          <span className="font-medium">{used ? `${used.uses}${used.errors ? (uk ? `, з помилкою ${used.errors}` : `, с ошибкой ${used.errors}`) : ""}` : uk ? "не спрацьовував" : "не срабатывал"}</span>
        </span>
        {cost && <span className="text-muted">{cost[locale]}</span>}
      </div>

      {m.key === "factGuard" && m.on(config) && (
        <Select value={config.factGuard} onChange={(e) => patch({ factGuard: e.target.value as AgentConfig["factGuard"] })}>
          <option value="flag">{uk ? "Позначати в «Діалогах»" : "Помечать в «Диалогах»"}</option>
          <option value="block">{uk ? "Не надсилати, а на погодження" : "Не отправлять, а на одобрение"}</option>
        </Select>
      )}
      {m.key === "budget" && m.on(config) && (
        <label className="flex items-center gap-2">
          <span className="text-muted">$</span>
          <Input type="number" min={0} step="1" value={config.monthlyBudgetUsd ?? 0} onChange={(e) => patch({ monthlyBudgetUsd: Math.max(0, Number(e.target.value)) })} />
          <span className="shrink-0 text-muted">{uk ? "на місяць" : "в месяц"}</span>
        </label>
      )}

      {m.key === "kb" && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={config.kbSourceIds === null} onChange={(e) => patch({ kbSourceIds: e.target.checked ? null : items.map((i) => i.id) })} />
            <span className="font-medium">{uk ? "Усі джерела клієнта" : "Все источники клиента"}</span>
          </label>
          {config.kbSourceIds !== null &&
            items.map((i) => (
              <label key={i.id} className="flex items-center gap-2 pl-6">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={config.kbSourceIds!.includes(i.id)}
                  onChange={(e) => patch({ kbSourceIds: e.target.checked ? [...config.kbSourceIds!, i.id] : config.kbSourceIds!.filter((x) => x !== i.id) })}
                />
                <span className="truncate">{i.name}</span>
              </label>
            ))}
        </div>
      )}

      {m.key === "loyalty" && (
        <Select value={config.loyaltyProgramId ?? ""} onChange={(e) => patch({ loyaltyProgramId: e.target.value || null })}>
          <option value="">{uk ? "Без програми балів" : "Без программы баллов"}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      )}

      {m.pick &&
        (items.length === 0 ? (
          <p className="text-muted">{uk ? "У клієнта поки нічого немає — створіть у повних налаштуваннях." : "У клиента пока ничего нет — создайте в полных настройках."}</p>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {items.map((i) => (
              <label key={i.id} className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={selectedIds.includes(i.id)} onChange={(e) => setPick(i.id, e.target.checked)} />
                <span className="truncate">{i.name}</span>
              </label>
            ))}
          </div>
        ))}

      <Link href={m.href(ctx)} className="inline-flex items-center gap-1 text-accent hover:underline">
        {uk ? "Повні налаштування" : "Полные настройки"}
        <ExternalLink className="size-3.5" />
      </Link>
    </div>
  );
}
