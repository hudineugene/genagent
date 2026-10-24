"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Plus, Radio, type LucideIcon } from "lucide-react";
import { CHANNEL_LABEL, GROUPS, MODULES, type Ctx, type GroupKey, type L, type MapStats, type Mod } from "@/lib/agent/map-modules";
import type { AgentConfig } from "@/lib/agent/types";
import { SwitchButton, cx } from "@/components/ui";

export type MapChannel = { id: string; type: string; name: string; enabled: boolean };
export type ModState = "on" | "off" | "warn";

/**
 * Полотно карты агента: каналы → ядро → группы модулей с линиями. Живые данные за 7 дней (stats), подсветка пути
 * ответа (highlight), отличия от другой версии (diff). Без onToggle/onSelect — только просмотр (кабинет владельца).
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
}) {
  const tr = (l: L) => l[locale];
  const uk = locale === "uk";
  const state = (m: Mod): ModState => (m.on(config) ? (ctx && m.warn?.(config, ctx) ? "warn" : "on") : "off");
  const groupOn = (g: GroupKey) => MODULES.some((m) => m.group === g && m.on(config));
  const rootRef = useRef<HTMLDivElement>(null);
  const maxConv = Math.max(1, ...channels.map((c) => stats?.channels[c.id]?.conversations ?? 0));
  const paths = useLines(rootRef, [channels.length, config, highlight ? [...highlight] : null, diff, stats ? 1 : 0]);

  const channelState = (c: MapChannel) => {
    const s = stats?.channels[c.id];
    if (!c.enabled) return { dot: "off" as ModState, bad: false, stale: false };
    const stale = Boolean(s?.stale);
    return { dot: (s?.errors ? "warn" : "on") as ModState, bad: Boolean(s?.errors), stale };
  };

  const channelBox = (c: MapChannel) => {
    const st = channelState(c);
    const s = stats?.channels[c.id];
    const width = c.enabled && s ? 1.5 + 3.5 * ((s.conversations ?? 0) / maxConv) : 1.5;
    const inner = (
      <>
        <Dot state={st.bad ? "bad" : st.dot} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{CHANNEL_LABEL[c.type] ?? c.type}</span>
          <span className="block truncate text-xs text-muted">{c.name}</span>
          {stats && c.enabled && (
            <span className={cx("block text-[11px]", st.bad ? "text-danger" : st.stale ? "text-amber-600 dark:text-amber-400" : "text-muted")}>
              {st.bad
                ? uk
                  ? `збоїв за 7 днів: ${s?.errors}`
                  : `сбоев за 7 дней: ${s?.errors}`
                : st.stale
                  ? uk
                    ? "тиждень без повідомлень"
                    : "неделю без сообщений"
                  : uk
                    ? `розмов за 7 днів: ${s?.conversations ?? 0}`
                    : `разговоров за 7 дней: ${s?.conversations ?? 0}`}
            </span>
          )}
        </span>
      </>
    );
    const cls = cx("flex items-center gap-2 rounded-xl border bg-surface px-3 py-2 text-sm transition", st.bad ? "border-danger/50" : "border-border", channelHref && "hover:border-accent/50");
    return channelHref ? (
      <Link key={c.id} data-node={`ch-${c.id}`} data-width={width} data-bad={st.bad ? 1 : 0} data-on={c.enabled ? 1 : 0} href={channelHref} className={cls}>
        {inner}
      </Link>
    ) : (
      <div key={c.id} data-node={`ch-${c.id}`} data-width={width} data-bad={st.bad ? 1 : 0} data-on={c.enabled ? 1 : 0} className={cls}>
        {inner}
      </div>
    );
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" aria-hidden>
        {paths.map((p) => (
          <path
            key={p.id}
            d={p.d}
            fill="none"
            strokeWidth={p.width}
            strokeDasharray={p.active ? undefined : "4 4"}
            className={p.bad ? "stroke-danger/60" : p.lit ? "stroke-amber-500" : p.active ? "stroke-accent/60" : "stroke-border"}
          />
        ))}
      </svg>
      <div className="relative grid gap-4 lg:grid-cols-[210px_220px_minmax(0,1fr)] lg:items-center lg:gap-14">
        <div className="space-y-2">
          <ColumnTitle icon={Radio} text={uk ? "Канали" : "Каналы"} />
          {channels.map((c) => channelBox(c))}
          {channels.length === 0 && <p className="px-1 text-xs text-muted">{uk ? "Каналів ще немає" : "Каналов ещё нет"}</p>}
          {onAddChannel && (
            <button type="button" data-node="ch-add" onClick={onAddChannel} className="flex w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted transition hover:border-accent/50 hover:text-text">
              <Plus className="size-4" />
              {uk ? "Підключити канал" : "Подключить канал"}
            </button>
          )}
        </div>

        <button
          type="button"
          data-node="core"
          disabled={!onSelect}
          onClick={() => onSelect?.("core")}
          className={cx("rounded-2xl border-2 bg-surface p-4 text-left transition", onSelect && "hover:border-accent", selectedKey === "core" ? "border-accent" : "border-accent/40")}
        >
          <div className="flex items-center gap-2">
            <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-xl">{config.icon || "🤖"}</span>
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
            <div className="mt-3 grid grid-cols-3 gap-1 border-t border-border pt-2 text-center text-[11px]">
              <Metric v={String(stats.replies)} l={uk ? "відповідей" : "ответов"} />
              <Metric v={String(stats.handoffs)} l={uk ? "передач" : "передач"} />
              <Metric v={`$${stats.costUsd.toFixed(2)}`} l={uk ? "за 7 днів" : "за 7 дней"} />
            </div>
          )}
        </button>

        <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(250px,1fr))]">
          {GROUPS.map((g) => (
            <div key={g.key} data-node={`grp-${g.key}`} data-lit={MODULES.some((m) => m.group === g.key && highlight?.has(m.key)) ? 1 : 0} className="min-w-0 rounded-2xl border border-border bg-surface p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <g.icon className={cx("size-4", groupOn(g.key) ? "text-accent" : "text-muted")} />
                {tr(g.title)}
              </div>
              <div className="grid gap-1.5">
                {MODULES.filter((m) => m.group === g.key).map((m) => {
                  const s = state(m);
                  const detail = ctx ? m.detail?.(config, ctx) : null;
                  const used = stats?.modules[m.key];
                  const lit = highlight?.has(m.key);
                  const d = diff?.[m.key];
                  const idle = s !== "off" && stats && stats.replies > 20 && !used && USAGE_TRACKED.has(m.key);
                  return (
                    <div
                      key={m.key}
                      role={onSelect ? "button" : undefined}
                      tabIndex={onSelect ? 0 : undefined}
                      onClick={() => onSelect?.(m.key)}
                      onKeyDown={(e) => onSelect && (e.key === "Enter" || e.key === " ") && onSelect(m.key)}
                      title={idle ? (uk ? "Увімкнено, але за 7 днів жодного разу не спрацював" : "Включён, но за 7 дней ни разу не сработал") : undefined}
                      className={cx(
                        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition",
                        onSelect && "cursor-pointer hover:border-accent/50",
                        lit ? "border-amber-500 bg-amber-500/10" : selectedKey === m.key ? "border-accent bg-accent-soft/40" : d === "added" ? "border-success/60 bg-success/5" : d === "removed" ? "border-danger/50 bg-danger/5" : "border-border",
                        s === "off" && !lit && "text-muted",
                      )}
                    >
                      <Dot state={s} />
                      <m.icon className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{tr(m.title)}</span>
                      {d && <span className={cx("text-xs font-semibold", d === "added" ? "text-success" : "text-danger")}>{d === "added" ? "+" : "−"}</span>}
                      {used && (
                        <span className={cx("rounded-full px-1.5 text-[11px] leading-4", used.errors ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent")} title={uk ? "Спрацювань за 7 днів" : "Срабатываний за 7 дней"}>
                          {used.uses}
                        </span>
                      )}
                      {idle && <span className="rounded-full bg-amber-500/15 px-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">0</span>}
                      {detail && <span className="text-xs text-muted">{detail}</span>}
                      {m.toggle && onToggle && <SwitchButton checked={m.on(config)} onChange={(v) => onToggle(m, v)} label={tr(m.title)} />}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Модули, срабатывание которых видно в переписке: только у них «0 за неделю» что-то значит. */
const USAGE_TRACKED = new Set(["kb", "tools", "tables", "forms", "procedures", "docs", "calendar", "logistics", "payments", "pricing", "loyalty", "learning", "web", "answerCheck", "quickReplies"]);

function Metric({ v, l }: { v: string; l: string }) {
  return (
    <div>
      <div className="font-semibold">{v}</div>
      <div className="text-muted">{l}</div>
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

type Path = { id: string; d: string; active: boolean; width: number; bad: boolean; lit: boolean };

/** Линии схемы: от каналов к ядру (толщина — число разговоров) и от ядра к группам (только на широком экране). */
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
        return { l: r.left - box.left, r: r.right - box.left, y: r.top - box.top + r.height / 2 };
      };
      const core = el.querySelector('[data-node="core"]');
      if (!core) return;
      const c = rect(core);
      const curve = (x1: number, y1: number, x2: number, y2: number) => {
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      };
      const out: Path[] = [];
      el.querySelectorAll('[data-node^="ch-"]').forEach((n) => {
        const r = rect(n);
        const on = n.getAttribute("data-on") === "1";
        out.push({ id: n.getAttribute("data-node")!, d: curve(r.r, r.y, c.l, c.y), active: on, width: Number(n.getAttribute("data-width") ?? 1.5), bad: n.getAttribute("data-bad") === "1", lit: false });
      });
      el.querySelectorAll('[data-node^="grp-"]').forEach((n) => {
        const r = rect(n);
        const lit = n.getAttribute("data-lit") === "1";
        out.push({ id: n.getAttribute("data-node")!, d: curve(c.r, c.y, r.l, r.y), active: n.querySelector(".bg-success, .bg-amber-500") !== null, width: lit ? 3 : 2, bad: false, lit });
      });
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
