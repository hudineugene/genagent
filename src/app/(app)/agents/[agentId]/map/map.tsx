"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Compass,
  Download,
  ExternalLink,
  FileText,
  FlaskConical,
  GitCompare,
  History,
  Layers,
  Link2,
  Loader2,
  Pause,
  Play,
  Route,
  Search,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Wand2,
  X,
} from "lucide-react";
import { saveAgent } from "@/app/actions/agents";
import { mapLive, mapReplay, mapReplayList } from "@/app/actions/map";
import type { AgentConfig } from "@/lib/agent/types";
import { EFFORTS, REPLY_LANGUAGES, TONES } from "@/lib/agent/types";
import {
  CHANNEL_LABEL,
  DEPENDENCIES,
  GROUPS,
  MODULES,
  PIPELINE,
  PRESETS,
  TESTABLE,
  brokenLinks,
  moduleCost,
  modulesDiff,
  toolModule,
  whatIf,
  type Ctx,
  type GroupKey,
  type Lists,
  type MapCoverage,
  type MapStats,
  type Mod,
  type ModuleChange,
  type Ready,
  type ReplayStep,
} from "@/lib/agent/map-modules";
import { ADD_KINDS } from "@/lib/channels/add-kinds";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Input, Select, SwitchButton, cx } from "@/components/ui";
import { Dot, MapCanvas, Spark, type LiveFx, type MapChannel, type ViewMode } from "@/components/agent-map/canvas";
import { downloadMapPng } from "@/components/agent-map/export";

type AgentView = { id: string; name: string; status: "draft" | "active" | "paused"; version: number; config: AgentConfig };
type Version = { version: number; at: string; config: AgentConfig };
type Panel = { kind: "core" } | { kind: "mod"; key: string } | { kind: "addChannel" } | null;
type PathResult = { modules: Set<string>; steps: { name: string; error?: boolean }[]; sources: string[]; reply: string; cost: number | null; ms: number | null; error?: string };
type ReplayConv = { id: string; contact: string; channel: string; channelId: string | null; at: number; last: string };

const ORDER = ["core", ...GROUPS.flatMap((g) => MODULES.filter((m) => m.group === g.key).map((m) => m.key))];
const COLLAPSE_KEY = "genagent:map:collapsed";

export function AgentMap({
  agent,
  clientId,
  channels,
  lists,
  ready,
  models,
  stats,
  versions,
  history,
  coverage,
}: {
  agent: AgentView;
  clientId: string;
  channels: MapChannel[];
  lists: Lists;
  ready: Ready;
  models: { id: string; label: string }[];
  stats: MapStats;
  versions: Version[];
  history: Record<string, ModuleChange[]>;
  coverage: MapCoverage | null;
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
  const [mode, setMode] = useState<ViewMode>("detailed");
  const [query, setQuery] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(new Set());
  // Свёрнутые группы — из памяти браузера после первой отрисовки (на сервере её нет)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        setCollapsed(new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]")));
      } catch {}
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
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
  const covered = useMemo(() => (coverage?.recorded ? new Set(coverage.modules) : null), [coverage]);

  // ---------- повтор разговора ----------
  const [replayOpen, setReplayOpen] = useState(false);
  const [convs, setConvs] = useState<ReplayConv[] | null>(null);
  const [replay, setReplay] = useState<{ conv: ReplayConv; steps: ReplayStep[]; i: number; playing: boolean } | null>(null);
  const step = replay?.steps[replay.i];
  useEffect(() => {
    if (!replay?.playing) return;
    const id = setTimeout(() => setReplay((r) => (r ? (r.i + 1 < r.steps.length ? { ...r, i: r.i + 1 } : { ...r, playing: false }) : r)), 1800);
    return () => clearTimeout(id);
  }, [replay]);
  const openReplay = async () => {
    setReplayOpen((v) => !v);
    if (!convs) setConvs(await mapReplayList(agent.id).catch(() => []));
  };
  const startReplay = async (c: ReplayConv) => {
    const steps = await mapReplay(agent.id, c.id).catch(() => null);
    setReplayOpen(false);
    if (steps?.length) {
      setPath(null);
      setReplay({ conv: c, steps, i: 0, playing: false });
    }
  };

  // ---------- живой режим ----------
  const [live, setLive] = useState(false);
  const [fx, setFx] = useState<LiveFx>({ flash: {}, pulses: {} });
  const [liveCount, setLiveCount] = useState(0);
  const sinceRef = useRef(0);
  useEffect(() => {
    if (!live) return;
    sinceRef.current = Date.now();
    let stopped = false;
    const tick = async () => {
      const r = await mapLive(agent.id, sinceRef.current).catch(() => null);
      if (stopped || !r) return;
      sinceRef.current = r.now;
      if (!r.events.length) return;
      setLiveCount((n) => n + r.events.length);
      setFx((f) => {
        const flash = { ...f.flash };
        const pulses = { ...f.pulses };
        for (const e of r.events) {
          if (e.channelId && (e.kind === "in" || e.kind === "error")) pulses[e.channelId] = (pulses[e.channelId] ?? 0) + 1;
          for (const m of e.modules ?? []) flash[m.key] = m.error ? "error" : "ok";
        }
        return { flash, pulses };
      });
      setTimeout(() => setFx((f) => ({ ...f, flash: {} })), 1700);
    };
    const id = setInterval(() => void tick(), 10_000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [live, agent.id]);

  // Подсветка: путь ответа или текущий шаг повтора
  const highlight = useMemo(() => {
    if (step) return new Set(step.modules.map((m) => m.key));
    return path?.modules ?? null;
  }, [step, path]);
  const replayFx = useMemo<LiveFx | null>(() => {
    if (!step || !replay) return null;
    if (step.role === "customer" && replay.conv.channelId) return { flash: {}, pulses: { [replay.conv.channelId]: replay.i + 1 } };
    if (step.role === "agent") return { flash: Object.fromEntries(step.modules.map((m) => [m.key, m.error ? "error" : "ok"])) as LiveFx["flash"], pulses: {} };
    return null;
  }, [step, replay]);

  // ---------- клавиатура: «/» — поиск, стрелки — по модулям, Enter — открыть, Esc — закрыть ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT" || e.target.isContentEditable);
      if (e.key === "Escape") {
        if (panel) setPanel(null);
        else setFocusKey(null);
        return;
      }
      if (typing) return;
      if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f")) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) {
        e.preventDefault();
        const visible = ORDER.filter((k) => k === "core" || !collapsed.has(MODULES.find((m) => m.key === k)!.group));
        const i = Math.max(0, visible.indexOf(focusKey ?? "core"));
        const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? visible[Math.min(visible.length - 1, i + (focusKey ? 1 : 0))] : visible[Math.max(0, i - 1)];
        setFocusKey(next);
        document.querySelector(next === "core" ? "#map-core" : `[data-mod="${next}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (e.key === "Enter" && focusKey) setPanel(focusKey === "core" ? { kind: "core" } : { kind: "mod", key: focusKey });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, focusKey, collapsed]);

  const toggleGroup = (g: GroupKey) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...n]));
      } catch {}
      return n;
    });

  // Что исправить: включённые модули с жёлтой точкой, неполные связи, каналы со сбоями, пустые основы
  const fixes = useMemo(() => {
    const out: { text: string; action: () => void }[] = [];
    if (channels.length === 0) out.push({ text: uk ? "Немає жодного каналу — клієнти не можуть написати агенту" : "Нет ни одного канала — клиенты не могут написать агенту", action: () => setPanel({ kind: "addChannel" }) });
    if (lists.kb.length === 0 && !config.knowledge.trim()) out.push({ text: uk ? "Немає бази знань і ключових фактів — агенту нема на що спиратися" : "Нет базы знаний и ключевых фактов — агенту не на что опираться", action: () => setPanel({ kind: "mod", key: "kb" }) });
    for (const m of MODULES) {
      const w = m.on(config) ? m.warn?.(config, ctx) : null;
      if (w) out.push({ text: `${m.title[locale]}: ${w[locale]}`, action: () => setPanel({ kind: "mod", key: m.key }) });
    }
    for (const d of brokenLinks(config).filter((x) => x.required)) {
      const a = MODULES.find((m) => m.key === d.from)!;
      const b = MODULES.find((m) => m.key === d.to)!;
      out.push({ text: `${a.title[locale]} → ${b.title[locale]}: ${d.why[locale]}`, action: () => setPanel({ kind: "mod", key: d.to }) });
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

  // «Что будет, если…»: изменения модулей против сохранённой версии
  const changes = MODULES.filter((m) => m.on(config) !== m.on(saved)).map((m) => ({ m, on: m.on(config), note: whatIf(m.key, m.on(config), stats) }));

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
    setReplay(null);
    const res: PathResult = { modules: new Set(config.knowledge.trim() ? ["facts"] : []), steps: [], sources: [], reply: "", cost: null, ms: null };
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

  const present = mode === "presentation";

  return (
    <div className={cx("space-y-4", present && "rounded-3xl bg-gradient-to-b from-accent-soft/30 to-transparent p-4 md:p-6")}>
      {/* Панель инструментов карты */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-border p-0.5 text-sm">
          {(["detailed", "compact", "presentation"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cx("rounded-lg px-2.5 py-1 transition", mode === m ? "bg-accent text-accent-text" : "text-muted hover:text-text")}>
              {m === "detailed" ? (uk ? "Детально" : "Подробно") : m === "compact" ? (uk ? "Стисло" : "Компактно") : uk ? "Презентація" : "Презентация"}
            </button>
          ))}
        </div>
        {!present && (
          <>
            <button
              type="button"
              onClick={() => setFixOpen((v) => !v)}
              className={cx("flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium transition", fixes.length ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-border text-muted")}
            >
              <AlertTriangle className="size-4" />
              {uk ? "Що виправити" : "Что исправить"} · {fixes.length}
            </button>
            <Menu icon={Layers} label={uk ? "Набір" : "Набор"}>
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
              <select className="max-w-40 bg-transparent outline-none" value={compare ?? ""} onChange={(e) => setCompare(e.target.value ? Number(e.target.value) : null)}>
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
            <button type="button" onClick={() => void openReplay()} className={cx("flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition", replay ? "border-amber-500/60 text-amber-700 dark:text-amber-300" : "border-border text-muted hover:text-text")}>
              <History className="size-4" />
              {uk ? "Повтор розмови" : "Повтор разговора"}
            </button>
            <button type="button" onClick={() => setLive((v) => !v)} className={cx("flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition", live ? "border-success/60 bg-success/10 text-success" : "border-border text-muted hover:text-text")}>
              <Activity className={cx("size-4", live && "animate-pulse")} />
              {uk ? "Наживо" : "Вживую"}
              {live && liveCount > 0 && <span className="text-xs">· {liveCount}</span>}
            </button>
            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted" />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={uk ? "Модуль… ( / )" : "Модуль… ( / )"} className="w-36 rounded-xl border border-border bg-transparent py-1.5 pr-2 pl-8 text-sm outline-none focus:border-accent" />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <a href={`/report/agent/${agent.id}`} target="_blank" rel="noopener" className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-muted transition hover:text-text">
            <FileText className="size-4" />
            PDF
          </a>
          <button type="button" onClick={exportPng} className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-muted transition hover:text-text">
            <Download className="size-4" />
            PNG
          </button>
        </div>
      </div>

      {!present && <Legend uk={uk} coverage={coverage} />}

      {fixOpen && !present && (
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

      {replayOpen && (
        <div className="rounded-2xl border border-border bg-surface p-2">
          {!convs ? (
            <p className="p-2 text-sm text-muted">
              <Loader2 className="inline size-4 animate-spin" />
            </p>
          ) : convs.length === 0 ? (
            <p className="p-2 text-sm text-muted">{uk ? "Розмов ще немає." : "Разговоров ещё нет."}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {convs.map((c) => (
                <button key={c.id} type="button" onClick={() => void startReplay(c)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2">
                  <span className="w-20 shrink-0 text-xs text-muted">{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.contact || (uk ? "Клієнт" : "Клиент")}</span>
                    <span className="block truncate text-xs text-muted">{c.last}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{new Date(c.at).toLocaleString(uk ? "uk-UA" : "ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {replay && step && <ReplayBar replay={replay} setReplay={setReplay} step={step} uk={uk} />}

      {/* Путь ответа */}
      {!present && !replay && (
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
      )}

      {dirty && !present && (
        <div className="sticky top-2 z-20 space-y-2 rounded-2xl border border-accent/40 bg-surface/95 p-3 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm font-medium">{uk ? "Є незбережені зміни" : "Есть несохранённые изменения"}</span>
            {error && <span className="text-sm text-danger">{uk ? "Не збереглося" : "Не сохранилось"}</span>}
            <Button variant="ghost" disabled={pending} onClick={() => setConfig(saved)}>
              {uk ? "Скасувати" : "Отменить"}
            </Button>
            <Button disabled={pending} onClick={save}>
              {uk ? "Зберегти нову версію" : "Сохранить новую версию"}
            </Button>
          </div>
          {changes.length > 0 && (
            <ul className="space-y-0.5 border-t border-border pt-2 text-xs">
              {changes.map(({ m, on, note }) => (
                <li key={m.key} className="flex gap-2">
                  <span className={cx("shrink-0 font-semibold", on ? "text-success" : "text-danger")}>{on ? "+" : "−"}</span>
                  <span className="shrink-0 font-medium">{m.title[locale]}</span>
                  {note && <span className="text-muted">— {note[locale]}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {other && diff && !present && (
        <p className="text-xs text-muted">
          {uk ? `Порівняння з v${other.version}: ` : `Сравнение с v${other.version}: `}
          <span className="text-success">+ {uk ? "увімкнено тепер" : "включено сейчас"}</span> · <span className="text-danger">− {uk ? "було у v" : "было в v"}{other.version}</span>
          {Object.keys(diff).length === 0 && (uk ? " — модулі однакові" : " — модули одинаковые")}
        </p>
      )}

      <MapCanvas
        config={config}
        agentName={agent.name}
        coreLines={present ? coreLines.slice(0, 3) : coreLines}
        channels={channels}
        ctx={ctx}
        stats={stats}
        highlight={highlight}
        diff={diff}
        selectedKey={panel?.kind === "core" ? "core" : panel?.kind === "mod" ? panel.key : null}
        onSelect={present ? undefined : (key) => setPanel(key === "core" ? { kind: "core" } : { kind: "mod", key })}
        onToggle={(m, v) => patch(m.toggle!(config, v))}
        onAddChannel={() => setPanel({ kind: "addChannel" })}
        channelHref={present ? undefined : `/agents/${agent.id}/channels`}
        locale={locale}
        coreTitle={uk ? "Ядро агента" : "Ядро агента"}
        mode={mode}
        query={query}
        focusKey={focusKey}
        collapsed={present ? new Set() : collapsed}
        onCollapse={present ? undefined : toggleGroup}
        covered={covered}
        fx={replayFx ?? fx}
        glow={Boolean(highlight?.size && (step?.role === "agent" || path))}
      />

      {!present && <Navigator collapsed={collapsed} config={config} uk={uk} />}

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
          {panel.kind === "mod" && current && (
            <ModulePanel m={current} config={config} patch={patch} ctx={ctx} uk={uk} stats={stats} history={history[current.key] ?? []} coverage={coverage} onOpen={(key) => setPanel({ kind: "mod", key })} />
          )}
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

/** Плеер повтора разговора: шаги, автопроигрывание, что сработало на текущем шаге. */
function ReplayBar({
  replay,
  setReplay,
  step,
  uk,
}: {
  replay: { conv: ReplayConv; steps: ReplayStep[]; i: number; playing: boolean };
  setReplay: (r: { conv: ReplayConv; steps: ReplayStep[]; i: number; playing: boolean } | null) => void;
  step: ReplayStep;
  uk: boolean;
}) {
  const go = (i: number) => setReplay({ ...replay, i: Math.max(0, Math.min(replay.steps.length - 1, i)), playing: false });
  const who =
    step.role === "customer" ? (uk ? "Клієнт" : "Клиент") : step.role === "agent" ? (uk ? "Агент" : "Агент") : step.role === "manager" ? (uk ? "Менеджер" : "Менеджер") : step.role === "bot" ? (uk ? "Бот" : "Бот") : uk ? "Подія" : "Событие";
  return (
    <div className="space-y-2 rounded-2xl border border-amber-500/40 bg-surface p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <History className="size-4 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {replay.conv.contact || (uk ? "Клієнт" : "Клиент")} · {CHANNEL_LABEL[replay.conv.channel] ?? replay.conv.channel}
        </span>
        <IconBtn onClick={() => go(0)} label="⏮">
          <SkipBack className="size-4" />
        </IconBtn>
        <IconBtn onClick={() => go(replay.i - 1)} label="◀">
          <StepBack className="size-4" />
        </IconBtn>
        <IconBtn onClick={() => setReplay({ ...replay, playing: !replay.playing, i: replay.i + 1 >= replay.steps.length ? 0 : replay.i })} label="▶">
          {replay.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </IconBtn>
        <IconBtn onClick={() => go(replay.i + 1)} label="▶|">
          <StepForward className="size-4" />
        </IconBtn>
        <IconBtn onClick={() => go(replay.steps.length - 1)} label="⏭">
          <SkipForward className="size-4" />
        </IconBtn>
        <span className="px-1 text-xs text-muted">
          {replay.i + 1}/{replay.steps.length}
        </span>
        <IconBtn onClick={() => setReplay(null)} label="×">
          <X className="size-4" />
        </IconBtn>
      </div>
      <input type="range" min={0} max={replay.steps.length - 1} value={replay.i} onChange={(e) => go(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
      <div className={cx("rounded-xl px-3 py-2 text-sm", step.role === "customer" ? "bg-surface-2" : step.role === "agent" ? "bg-accent-soft/50" : step.error ? "bg-danger/10" : "bg-amber-500/10")}>
        <div className="mb-0.5 text-xs font-medium text-muted">
          {who} · {new Date(step.at).toLocaleString(uk ? "uk-UA" : "ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="whitespace-pre-wrap">{step.role === "event" ? (step.text === "handoff" ? (uk ? "Передано менеджеру" : "Передано менеджеру") : step.text) : step.text}</div>
      </div>
      {step.role === "agent" && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {step.sources?.map((s) => (
            <Badge key={s}>📄 {s}</Badge>
          ))}
          {step.tools?.map((s, i) => (
            <Badge key={i} tone="accent">
              🔧 {s}
            </Badge>
          ))}
          {step.check && (
            <Badge tone={step.check.ok ? "success" : "warning"}>
              {step.check.ok ? (uk ? "перевірка: ок" : "проверка: ок") : `${uk ? "перевірка" : "проверка"}: ${step.check.problems.join("; ")}${step.check.rewritten ? (uk ? " · переписано" : " · переписан") : ""}`}
            </Badge>
          )}
          {step.unverified?.length ? <Badge tone="warning">{(uk ? "неперевірені факти: " : "непроверенные факты: ") + step.unverified.join(", ")}</Badge> : null}
          {step.handoff && <Badge tone="warning">{uk ? "передав менеджеру" : "передал менеджеру"}</Badge>}
          {step.ms != null && <Badge>{(step.ms / 1000).toFixed(1)} с</Badge>}
          {step.cost != null && <Badge>${step.cost.toFixed(4)}</Badge>}
        </div>
      )}
    </div>
  );
}

function IconBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="grid size-7 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text">
      {children}
    </button>
  );
}

/** Навигатор: кнопка справа внизу; раскрывается в короткий путь к каналам, ядру и группам. */
function Navigator({ collapsed, config, uk }: { collapsed: Set<GroupKey>; config: AgentConfig; uk: boolean }) {
  const [open, setOpen] = useState(false);
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setOpen(false);
  };
  return (
    <div className="fixed right-4 bottom-4 z-30 hidden lg:block">
      {open ? (
        <div className="w-48 rounded-2xl border border-border bg-surface/95 p-2 text-xs shadow-lg backdrop-blur">
          <div className="flex items-center px-1.5 pb-1 font-medium text-muted">
            <span className="flex-1">{uk ? "Навігатор" : "Навигатор"}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="×" className="hover:text-text">
              <X className="size-3.5" />
            </button>
          </div>
          <button type="button" onClick={() => jump("map-channels")} className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2">
            {uk ? "Канали" : "Каналы"}
          </button>
          <button type="button" onClick={() => jump("map-core")} className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2">
            {uk ? "Ядро" : "Ядро"}
          </button>
          {GROUPS.map((g) => (
            <button key={g.key} type="button" onClick={() => jump(`map-grp-${g.key}`)} className={cx("flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2", collapsed.has(g.key) && "text-muted")}>
              <span className="min-w-0 flex-1 truncate">{g.title[uk ? "uk" : "ru"]}</span>
              <span className="flex gap-0.5">
                {MODULES.filter((m) => m.group === g.key).map((m) => (
                  <span key={m.key} className={cx("size-1.5 rounded-full", m.on(config) ? "bg-success" : "bg-muted/30")} />
                ))}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-2 text-xs font-medium text-muted shadow-lg backdrop-blur transition hover:text-text">
          <Compass className="size-4" />
          {uk ? "Навігатор" : "Навигатор"}
        </button>
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

function Legend({ uk, coverage }: { uk: boolean; coverage: MapCoverage | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
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
      <span className="flex items-center gap-1.5">
        <FlaskConical className="size-3 text-success" />
        {coverage?.recorded
          ? uk
            ? `тести v${coverage.version}: ${coverage.passed}/${coverage.total}`
            : `тесты v${coverage.version}: ${coverage.passed}/${coverage.total}`
          : uk
            ? "покриття тестами — після наступної перевірки"
            : "покрытие тестами — после следующей проверки"}
      </span>
      <span className="hidden lg:inline">{uk ? "Клавіші: / — пошук, стрілки — модулі, Enter — відкрити" : "Клавиши: / — поиск, стрелки — модули, Enter — открыть"}</span>
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

function ModulePanel({
  m,
  config,
  patch,
  ctx,
  uk,
  stats,
  history,
  coverage,
  onOpen,
}: {
  m: Mod;
  config: AgentConfig;
  patch: (p: Partial<AgentConfig>) => void;
  ctx: Ctx;
  uk: boolean;
  stats: MapStats;
  history: ModuleChange[];
  coverage: MapCoverage | null;
  onOpen: (key: string) => void;
}) {
  const locale = uk ? "uk" : "ru";
  const warn = m.on(config) ? m.warn?.(config, ctx) : null;
  const items = m.pick ? ctx.lists[m.pick.list] : m.key === "kb" ? ctx.lists.kb : m.key === "loyalty" ? ctx.lists.programs : [];
  const selectedIds: string[] = m.pick ? (config[m.pick.field] ?? []) : [];
  const used = stats.modules[m.key];
  const cost = moduleCost(m.key, stats);
  const links = DEPENDENCIES.filter((d) => d.from === m.key || d.to === m.key);
  const isOn = (k: string) => MODULES.find((x) => x.key === k)?.on(config) ?? false;
  const title = (k: string) => MODULES.find((x) => x.key === k)?.title[locale] ?? k;
  const setPick = (id: string, on: boolean) => {
    if (!m.pick) return;
    const next = on ? [...selectedIds, id] : selectedIds.filter((x) => x !== id);
    patch({ [m.pick.field]: next } as Partial<AgentConfig>);
  };
  const fmt = (ms: number) => new Date(ms).toLocaleString(uk ? "uk-UA" : "ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
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
        <span className="flex items-center gap-2">
          {uk ? "За 7 днів: " : "За 7 дней: "}
          <span className="font-medium">{used ? `${used.uses}${used.errors ? (uk ? `, з помилкою ${used.errors}` : `, с ошибкой ${used.errors}`) : ""}` : uk ? "не спрацьовував" : "не срабатывал"}</span>
          <span className="ml-auto">
            <Spark data={stats.daily.modules[m.key]} />
          </span>
        </span>
        {cost && <span className="text-muted">{cost[locale]}</span>}
        {TESTABLE.has(m.key) && (
          <span className={cx("flex items-center gap-1", coverage?.recorded && coverage.modules.includes(m.key) ? "text-success" : "text-muted")}>
            <FlaskConical className="size-3" />
            {!coverage
              ? uk
                ? "тестів ще не було"
                : "тестов ещё не было"
              : !coverage.recorded
                ? uk
                  ? "покриття видно після наступної перевірки"
                  : "покрытие видно после следующей проверки"
                : coverage.modules.includes(m.key)
                  ? uk
                    ? `перевіряється тестами (v${coverage.version})`
                    : `проверяется тестами (v${coverage.version})`
                  : uk
                    ? "жоден сценарій не перевіряє"
                    : "ни один сценарий не проверяет"}
            {coverage?.recorded && !coverage.modules.includes(m.key) && (
              <Link href={`/agents/${ctx.agentId}/tests`} className="ml-1 text-accent hover:underline">
                {uk ? "додати сценарій" : "добавить сценарий"}
              </Link>
            )}
          </span>
        )}
      </div>

      {links.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted">
            <Link2 className="size-3.5" />
            {uk ? "Зв'язки" : "Связи"}
          </div>
          {links.map((d, i) => {
            const otherKey = d.from === m.key ? d.to : d.from;
            const missing = d.from === m.key && m.on(config) && !isOn(d.to);
            return (
              <button key={i} type="button" onClick={() => onOpen(otherKey)} className={cx("block w-full rounded-lg border px-2.5 py-1.5 text-left text-xs transition hover:border-accent/50", missing ? "border-amber-500/50 bg-amber-500/5" : "border-border")}>
                <span className="font-medium">
                  {d.from === m.key ? "→ " : "← "}
                  {title(otherKey)}
                </span>
                <span className="text-muted"> · {d.why[locale]}</span>
                {missing && <span className="block text-amber-700 dark:text-amber-300">{d.required ? (uk ? "Без нього не працює — увімкніть" : "Без него не работает — включите") : uk ? "Варто увімкнути" : "Стоит включить"}</span>}
              </button>
            );
          })}
        </div>
      )}

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

      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted">
          <History className="size-3.5" />
          {uk ? "Історія" : "История"}
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted">{uk ? "Не змінювався в останніх версіях" : "Не менялся в последних версиях"}</p>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {history.slice(0, 8).map((h) => (
              <li key={h.version} className="flex gap-2">
                <span className={cx("w-3 shrink-0 font-semibold", h.on ? "text-success" : "text-danger")}>{h.on ? "+" : "−"}</span>
                <span className="shrink-0 font-medium">v{h.version}</span>
                <span className="text-muted">
                  {fmt(h.at)}
                  {h.by ? ` · ${h.by}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link href={m.href(ctx)} className="inline-flex items-center gap-1 text-accent hover:underline">
        {uk ? "Повні налаштування" : "Полные настройки"}
        <ExternalLink className="size-3.5" />
      </Link>
    </div>
  );
}
