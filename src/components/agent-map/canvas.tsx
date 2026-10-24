"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, FlaskConical, Plus, Radio, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { CHANNEL_BRAND, CHANNEL_LABEL, DEPENDENCIES, GROUPS, MODULES, TESTABLE, type Ctx, type GroupKey, type L, type MapStats, type Mod } from "@/lib/agent/map-modules";
import type { AgentConfig } from "@/lib/agent/types";
import { SwitchButton, cx } from "@/components/ui";

export type MapChannel = { id: string; type: string; name: string; enabled: boolean };
export type ModState = "on" | "off" | "warn";
export type ViewMode = "detailed" | "compact" | "presentation";
/** Живой режим: вспышки модулей (ok/error) и импульсы по линиям каналов (id → счётчик, растёт при каждом событии) */
export type LiveFx = { flash: Record<string, "ok" | "error">; pulses: Record<string, number> };

/**
 * Полотно карты агента: каналы → ядро → группы модулей с линиями. Живые данные (stats), тренды за 30 дней, подсветка
 * пути ответа или повтора (highlight), отличия от версии (diff), связи выбранного модуля, покрытие тестами, вспышки
 * живого режима. Без onToggle/onSelect — только просмотр (кабинет владельца).
 */
export function MapCanvas({
  config,
  agentName,
  coreLines,
  channels,
  ctx,
  stats,
  highlight,
  diff,
  selectedKey,
  onSelect,
  onToggle,
  onAddChannel,
  channelHref,
  locale,
  coreTitle,
  mode = "detailed",
  query = "",
  focusKey = null,
  collapsed,
  onCollapse,
  covered,
  fx,
  glow,
}: {
  config: AgentConfig;
  agentName: string;
  coreLines: { k: string; v: string }[];
  channels: MapChannel[];
  ctx: Ctx | null;
  stats: MapStats | null;
  highlight?: Set<string> | null;
  diff?: Record<string, "added" | "removed"> | null;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  onToggle?: (m: Mod, on: boolean) => void;
  onAddChannel?: () => void;
  channelHref?: string;
  locale: "ru" | "uk";
  coreTitle: string;
  mode?: ViewMode;
  query?: string;
  focusKey?: string | null;
  collapsed?: Set<GroupKey>;
  onCollapse?: (g: GroupKey) => void;
  /** Модули, проверенные тестами (null — нет данных о покрытии) */
  covered?: Set<string> | null;
  fx?: LiveFx | null;
  glow?: boolean;
}) {
  const tr = (l: L) => l[locale];
  const uk = locale === "uk";
  const present = mode === "presentation";
  const compact = mode === "compact";
  const q = query.trim().toLowerCase();
  const state = (m: Mod): ModState => (m.on(config) ? (ctx && m.warn?.(config, ctx) ? "warn" : "on") : "off");
  const groupOn = (g: GroupKey) => MODULES.some((m) => m.group === g && m.on(config));
  const rootRef = useRef<HTMLDivElement>(null);
  const maxConv = Math.max(1, ...channels.map((c) => stats?.channels[c.id]?.conversations ?? 0));
  const deps = selectedKey && selectedKey !== "core" ? DEPENDENCIES.filter((d) => d.from === selectedKey || d.to === selectedKey) : [];
  const paths = useLines(rootRef, [channels.length, config, highlight ? [...highlight] : null, diff, stats ? 1 : 0, mode, collapsed ? [...collapsed] : null, selectedKey, deps.length, q, fx?.pulses]);

  const channelState = (c: MapChannel) => {
    const s = stats?.channels[c.id];
    if (!c.enabled) return { bad: false, stale: false };
    return { bad: Boolean(s?.errors), stale: Boolean(s?.stale) };
  };

  const channelBox = (c: MapChannel) => {
    const st = channelState(c);
    const s = stats?.channels[c.id];
    const width = c.enabled && s ? 1.5 + 3.5 * ((s.conversations ?? 0) / maxConv) : 1.5;
    const brand = CHANNEL_BRAND[c.type] ?? { color: "#64748b", short: "?" };
    const inner = (
      <>
        <span className="relative grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ background: c.enabled ? brand.color : "#94a3b8" }}>
          {brand.short}
          <span className={cx("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--surface)]", st.bad ? "bg-danger" : c.enabled ? "bg-success" : "bg-muted/40")} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{CHANNEL_LABEL[c.type] ?? c.type}</span>
          <span className="block truncate text-xs text-muted">{c.name}</span>
          {stats && c.enabled && !present && (
            <span className={cx("block text-[11px]", st.bad ? "text-danger" : st.stale ? "text-amber-600 dark:text-amber-400" : "text-muted")}>
              {st.bad ? (uk ? `збоїв за 7 днів: ${s?.errors}` : `сбоев за 7 дней: ${s?.errors}`) : st.stale ? (uk ? "тиждень без повідомлень" : "неделю без сообщений") : uk ? `розмов за 7 днів: ${s?.conversations ?? 0}` : `разговоров за 7 дней: ${s?.conversations ?? 0}`}
            </span>
          )}
        </span>
        {stats && !present && <Spark data={stats.daily.channels[c.id]} />}
      </>
    );
    const cls = cx(
      "flex items-center gap-2.5 rounded-xl border bg-surface px-2.5 py-2 text-sm transition",
      st.bad ? "border-danger/50" : "border-border",
      channelHref && "hover:border-accent/50 hover:shadow-sm",
      present && "py-3 text-base",
    );
    const pulse = fx?.pulses[c.id] ?? 0;
    const attrs = { "data-node": `ch-${c.id}`, "data-width": width, "data-bad": st.bad ? 1 : 0, "data-on": c.enabled ? 1 : 0, "data-pulse": pulse, "data-conv": c.enabled ? (s?.conversations ?? 0) : 0 };
    const style = pulse ? { animation: "map-ping 1.2s ease-out" } : undefined;
    return channelHref ? (
      <Link key={`${c.id}-${pulse}`} {...attrs} href={channelHref} className={cls} style={style}>
        {inner}
      </Link>
    ) : (
      <div key={`${c.id}-${pulse}`} {...attrs} className={cls} style={style}>
        {inner}
      </div>
    );
  };

  const visibleMods = (g: GroupKey) => MODULES.filter((m) => m.group === g && (!compact || m.on(config) || highlight?.has(m.key) || diff?.[m.key]));

  return (
    <div ref={rootRef} className={cx("relative min-w-0", present && "text-[15px]")}>
      <style>{`
        @keyframes map-ping { 0% { box-shadow: 0 0 0 0 rgb(99 102 241 / .45) } 100% { box-shadow: 0 0 0 12px rgb(99 102 241 / 0) } }
        @keyframes map-flash { 0% { background: rgb(16 185 129 / .25) } 100% { background: transparent } }
        @keyframes map-flash-err { 0%, 60% { background: rgb(239 68 68 / .25) } 100% { background: transparent } }
        @keyframes map-glow { 0%, 100% { box-shadow: 0 0 0 0 rgb(245 158 11 / 0) } 50% { box-shadow: 0 0 28px 4px rgb(245 158 11 / .35) } }
        @media (prefers-reduced-motion: reduce) { .map-motion { display: none } }
      `}</style>
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" aria-hidden>
        {paths.map((p) => (
          <g key={p.id}>
            <path
              id={`mp-${p.id}`}
              d={p.d}
              fill="none"
              strokeWidth={p.width}
              strokeDasharray={p.dep ? "3 5" : p.active ? undefined : "4 4"}
              className={p.dep ? "stroke-violet-500/70" : p.bad ? "stroke-danger/60" : p.lit ? "stroke-amber-500" : p.active ? "stroke-accent/50" : "stroke-border"}
            />
            {/* Частицы: поток по каналу пропорционален разговорам, по подсвеченной линии — путь ответа */}
            {(p.particles > 0 || p.lit) &&
              Array.from({ length: p.lit ? 3 : p.particles }, (_, i) => (
                <circle key={i} r={p.lit ? 3.5 : 2.5} className={cx("map-motion", p.lit ? "fill-amber-500" : "fill-accent/70")}>
                  <animateMotion dur={`${p.lit ? 1.6 : 3.2}s`} begin={`${(i * (p.lit ? 1.6 : 3.2)) / Math.max(1, p.lit ? 3 : p.particles)}s`} repeatCount="indefinite">
                    <mpath href={`#mp-${p.id}`} />
                  </animateMotion>
                </circle>
              ))}
            {p.pulse > 0 && (
              <circle key={`pulse-${p.pulse}`} r={5} className="map-motion fill-accent">
                <animateMotion dur="0.9s" repeatCount="1" fill="freeze">
                  <mpath href={`#mp-${p.id}`} />
                </animateMotion>
                <animate attributeName="opacity" from="1" to="0" dur="0.9s" fill="freeze" />
              </circle>
            )}
          </g>
        ))}
      </svg>
      <div className={cx("relative grid gap-3 lg:items-center lg:gap-14", present ? "lg:grid-cols-[240px_260px_minmax(0,1fr)]" : "lg:grid-cols-[230px_220px_minmax(0,1fr)]")}>
        <div className="space-y-2" id="map-channels">
          <ColumnTitle icon={Radio} text={uk ? "Канали" : "Каналы"} />
          {channels.map((c) => channelBox(c))}
          {channels.length === 0 && <p className="px-1 text-xs text-muted">{uk ? "Каналів ще немає" : "Каналов ещё нет"}</p>}
          {onAddChannel && !present && (
            <button type="button" data-node="ch-add" onClick={onAddChannel} className="flex w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted transition hover:border-accent/50 hover:text-text">
              <Plus className="size-4" />
              {uk ? "Підключити канал" : "Подключить канал"}
            </button>
          )}
        </div>

        <Down />

        <button
          type="button"
          data-node="core"
          id="map-core"
          disabled={!onSelect}
          onClick={() => onSelect?.("core")}
          style={glow ? { animation: "map-glow 1.6s ease-in-out infinite" } : undefined}
          className={cx(
            "rounded-2xl border-2 bg-gradient-to-br from-accent-soft/60 to-surface p-4 text-left shadow-sm transition",
            onSelect && "hover:border-accent",
            selectedKey === "core" || focusKey === "core" ? "border-accent" : "border-accent/40",
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cx("grid place-items-center rounded-xl bg-surface shadow-sm", present ? "size-12 text-2xl" : "size-10 text-xl")}>{config.icon || "🤖"}</span>
            <span className="min-w-0">
              <span className="block truncate font-semibold">{agentName}</span>
              <span className="block text-xs text-muted">{coreTitle}</span>
            </span>
          </div>
          <dl className="mt-3 space-y-1 text-xs">
            {coreLines.map((r) => (
              <div key={r.k} className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted">{r.k}</dt>
                <dd className="min-w-0 truncate font-medium">{r.v}</dd>
              </div>
            ))}
          </dl>
          {stats && (
            <div className="mt-3 border-t border-border pt-2">
              <div className="grid grid-cols-3 gap-1 text-center text-[11px]">
                <Metric v={String(stats.replies)} l={uk ? "відповідей" : "ответов"} />
                <Metric v={String(stats.handoffs)} l={uk ? "передач" : "передач"} />
                <Metric v={`$${stats.costUsd.toFixed(2)}`} l={uk ? "за 7 днів" : "за 7 дней"} />
              </div>
              {!present && stats.daily.replies.some((x) => x > 0) && (
                <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-muted">
                  <Spark data={stats.daily.replies} wide />
                  {uk ? "за 30 днів" : "за 30 дней"}
                </div>
              )}
            </div>
          )}
        </button>

        <Down />

        <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(250px,1fr))]">
          {GROUPS.map((g) => {
            const mods = visibleMods(g.key);
            if (compact && mods.length === 0) return null;
            const isCollapsed = collapsed?.has(g.key);
            const total = MODULES.filter((m) => m.group === g.key).length;
            const onCount = MODULES.filter((m) => m.group === g.key && m.on(config)).length;
            return (
              <div
                key={g.key}
                id={`map-grp-${g.key}`}
                data-node={`grp-${g.key}`}
                data-lit={MODULES.some((m) => m.group === g.key && highlight?.has(m.key)) ? 1 : 0}
                className="min-w-0 scroll-mt-24 rounded-2xl border border-border bg-surface/95 p-3 shadow-sm backdrop-blur"
              >
                <button type="button" onClick={() => onCollapse?.(g.key)} disabled={!onCollapse} className="mb-2 flex w-full items-center gap-2 text-left text-sm font-semibold">
                  <g.icon className={cx("size-4", groupOn(g.key) ? "text-accent" : "text-muted")} />
                  <span className="flex-1">{tr(g.title)}</span>
                  <span className="text-xs font-normal text-muted">
                    {onCount}/{total}
                  </span>
                  {onCollapse && <ChevronDown className={cx("size-3.5 text-muted transition", isCollapsed && "-rotate-90")} />}
                </button>
                {!isCollapsed && (
                  <div className="grid gap-1.5">
                    {mods.map((m) => {
                      const s = state(m);
                      const detail = ctx && !present ? m.detail?.(config, ctx) : null;
                      const used = stats?.modules[m.key];
                      const lit = highlight?.has(m.key);
                      const d = diff?.[m.key];
                      const idle = s !== "off" && stats && stats.replies > 20 && !used && USAGE_TRACKED.has(m.key);
                      const match = !q || tr(m.title).toLowerCase().includes(q);
                      const flash = fx?.flash[m.key];
                      const isDep = deps.some((x) => x.from === m.key || x.to === m.key) && selectedKey !== m.key;
                      return (
                        <div
                          key={m.key}
                          data-mod={m.key}
                          data-dep={isDep ? 1 : 0}
                          data-sel={selectedKey === m.key ? 1 : 0}
                          role={onSelect ? "button" : undefined}
                          tabIndex={onSelect ? 0 : undefined}
                          onClick={() => onSelect?.(m.key)}
                          onKeyDown={(e) => onSelect && (e.key === "Enter" || e.key === " ") && onSelect(m.key)}
                          title={idle ? (uk ? "Увімкнено, але за 7 днів жодного разу не спрацював" : "Включён, но за 7 дней ни разу не сработал") : undefined}
                          style={flash ? { animation: `${flash === "error" ? "map-flash-err" : "map-flash"} 1.6s ease-out` } : undefined}
                          className={cx(
                            "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition",
                            onSelect && "cursor-pointer hover:border-accent/50",
                            lit ? "border-amber-500 bg-amber-500/10" : selectedKey === m.key ? "border-accent bg-accent-soft/40" : isDep ? "border-violet-500/60 bg-violet-500/5" : d === "added" ? "border-success/60 bg-success/5" : d === "removed" ? "border-danger/50 bg-danger/5" : "border-border",
                            focusKey === m.key && "ring-2 ring-accent/60",
                            s === "off" && !lit && "text-muted",
                            !match && "opacity-30",
                            present && "py-2",
                          )}
                        >
                          <Dot state={s} />
                          <m.icon className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{tr(m.title)}</span>
                          {d && <span className={cx("text-xs font-semibold", d === "added" ? "text-success" : "text-danger")}>{d === "added" ? "+" : "−"}</span>}
                          {covered && TESTABLE.has(m.key) && s !== "off" && !present && (
                            <span title={covered.has(m.key) ? (uk ? "перевіряється тестами" : "проверяется тестами") : uk ? "не перевіряється тестами" : "не проверяется тестами"}>
                              <FlaskConical className={cx("size-3 shrink-0", covered.has(m.key) ? "text-success" : "text-muted/50")} />
                            </span>
                          )}
                          {used && !present && (
                            <span className={cx("rounded-full px-1.5 text-[11px] leading-4", used.errors ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent")} title={uk ? "Спрацювань за 7 днів" : "Срабатываний за 7 дней"}>
                              {used.uses}
                            </span>
                          )}
                          {idle && !present && <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">0</span>}
                          {detail && <span className="text-xs text-muted">{detail}</span>}
                          {m.toggle && onToggle && !present && <SwitchButton checked={m.on(config)} onChange={(v) => onToggle(m, v)} label={tr(m.title)} />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Модули, срабатывание которых видно в переписке: только у них «0 за неделю» что-то значит. */
const USAGE_TRACKED = new Set(["kb", "tools", "tables", "forms", "procedures", "docs", "calendar", "logistics", "payments", "pricing", "loyalty", "learning", "web", "answerCheck", "quickReplies"]);

/** Тренд за 30 дней: маленький график и стрелка (последние 7 дней против предыдущих 7). */
export function Spark({ data, wide }: { data?: number[]; wide?: boolean }) {
  if (!data || data.every((x) => x === 0)) return null;
  const w = wide ? 90 : 48;
  const h = 16;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const now = sum(data.slice(-7));
  const before = sum(data.slice(-14, -7));
  const up = now > before * 1.15 && now > 0;
  const down = now < before * 0.85;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="overflow-visible">
        <polyline points={pts} fill="none" strokeWidth={1.5} strokeLinejoin="round" className="stroke-accent/70" />
      </svg>
      {up && <TrendingUp className="size-3 text-success" />}
      {down && <TrendingDown className="size-3 text-danger" />}
    </span>
  );
}

function Metric({ v, l }: { v: string; l: string }) {
  return (
    <div>
      <div className="font-semibold">{v}</div>
      <div className="text-muted">{l}</div>
    </div>
  );
}

/** Телефон: стрелка вниз между каналами, ядром и модулями — поток читается сверху вниз. */
function Down() {
  return (
    <div className="flex justify-center lg:hidden" aria-hidden>
      <span className="flex flex-col items-center text-accent/60">
        <span className="h-5 w-px bg-accent/40" />
        <ChevronDown className="-mt-1 size-4" />
      </span>
    </div>
  );
}

export function Dot({ state }: { state: ModState | "bad" }) {
  return <span className={cx("size-2 shrink-0 rounded-full", state === "on" ? "bg-success" : state === "warn" ? "bg-amber-500" : state === "bad" ? "bg-danger" : "bg-muted/30")} />;
}

function ColumnTitle({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted">
      <Icon className="size-3.5" />
      {text}
    </div>
  );
}

type Path = { id: string; d: string; active: boolean; width: number; bad: boolean; lit: boolean; dep: boolean; particles: number; pulse: number };

/** Линии схемы: каналы → ядро (толщина и частицы — по разговорам), ядро → группы, связи выбранного модуля (только на широком экране). */
function useLines(root: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [paths, setPaths] = useState<Path[]>([]);
  const key = JSON.stringify(deps);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      if (!window.matchMedia("(min-width: 1024px)").matches) return setPaths([]);
      const box = el.getBoundingClientRect();
      const rect = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { l: r.left - box.left, r: r.right - box.left, y: r.top - box.top + r.height / 2, top: r.top - box.top, cx: r.left - box.left + r.width / 2 };
      };
      const core = el.querySelector('[data-node="core"]');
      if (!core) return;
      const c = rect(core);
      const curve = (x1: number, y1: number, x2: number, y2: number) => {
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      };
      const out: Path[] = [];
      const chNodes = [...el.querySelectorAll('[data-node^="ch-"]')];
      const maxConv = Math.max(1, ...chNodes.map((n) => Number(n.getAttribute("data-conv") ?? 0)));
      for (const n of chNodes) {
        const r = rect(n);
        const on = n.getAttribute("data-on") === "1";
        const conv = Number(n.getAttribute("data-conv") ?? 0);
        out.push({
          id: n.getAttribute("data-node")!,
          d: curve(r.r, r.y, c.l, c.y),
          active: on,
          width: Number(n.getAttribute("data-width") ?? 1.5),
          bad: n.getAttribute("data-bad") === "1",
          lit: false,
          dep: false,
          particles: on && conv > 0 ? Math.max(1, Math.round((3 * conv) / maxConv)) : 0,
          pulse: Number(n.getAttribute("data-pulse") ?? 0),
        });
      }
      el.querySelectorAll('[data-node^="grp-"]').forEach((n) => {
        const r = rect(n);
        const lit = n.getAttribute("data-lit") === "1";
        out.push({ id: n.getAttribute("data-node")!, d: curve(c.r, c.y, r.l, r.top + 22), active: n.querySelector(".bg-success, .bg-amber-500") !== null, width: lit ? 3 : 2, bad: false, lit, dep: false, particles: 0, pulse: 0 });
      });
      // Связи выбранного модуля: пунктир между строками модулей
      const sel = el.querySelector('[data-mod][data-sel="1"]');
      if (sel) {
        const a = rect(sel);
        el.querySelectorAll('[data-mod][data-dep="1"]').forEach((n) => {
          const b = rect(n);
          const right = b.cx > a.cx;
          out.push({ id: `dep-${sel.getAttribute("data-mod")}-${n.getAttribute("data-mod")}`, d: curve(right ? a.r : a.l, a.y, right ? b.l : b.r, b.y), active: true, width: 1.5, bad: false, lit: false, dep: true, particles: 0, pulse: 0 });
        });
      }
      setPaths(out);
    };
    // Раскладка и шрифты устанавливаются не сразу — меряем ещё раз чуть позже
    const frame = requestAnimationFrame(measure);
    const later = setTimeout(measure, 400);
    void document.fonts?.ready.then(measure);
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [root, key]);
  return paths;
}
