"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Network, Plus } from "lucide-react";
import { CHANNEL_LABEL } from "@/lib/agent/map-modules";
import { useI18n } from "@/lib/i18n/client";
import { cx } from "@/components/ui";
import { Dot } from "@/components/agent-map/canvas";
import { ChannelIcon } from "@/components/agent-map/channel-icon";

export type ClientMapAgent = { id: string; name: string; icon: string; status: "draft" | "active" | "paused"; conversations: number; channels: { type: string; name: string; enabled: boolean }[] };
export type ClientMapResource = { key: string; title: string; count: number; unused: number; href: string; usedBy: string[]; ready: boolean };

/** Карта клиента: агенты (с каналами) слева, общие ресурсы справа; линия — агент пользуется ресурсом. Наведение — связи одного узла. */
export function ClientMapView({ agents, resources, clientId }: { agents: ClientMapAgent[]; resources: ClientMapResource[]; clientId: string }) {
  const { locale } = useI18n();
  const uk = locale === "uk";
  const root = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [lines, setLines] = useState<{ id: string; d: string; a: string; r: string }[]>([]);
  const key = JSON.stringify([agents.map((a) => a.id), resources.map((r) => [r.key, r.usedBy])]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      if (!window.matchMedia("(min-width: 1024px)").matches) return setLines([]);
      const box = el.getBoundingClientRect();
      const out: { id: string; d: string; a: string; r: string }[] = [];
      for (const r of resources)
        for (const a of r.usedBy) {
          const an = el.querySelector(`[data-agent="${a}"]`);
          const rn = el.querySelector(`[data-res="${r.key}"]`);
          if (!an || !rn) continue;
          const A = an.getBoundingClientRect();
          const R = rn.getBoundingClientRect();
          const x1 = A.right - box.left;
          const y1 = A.top - box.top + A.height / 2;
          const x2 = R.left - box.left;
          const y2 = R.top - box.top + R.height / 2;
          const mx = (x1 + x2) / 2;
          out.push({ id: `${a}-${r.key}`, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, a, r: r.key });
        }
      setLines(out);
    };
    const frame = requestAnimationFrame(measure);
    const later = setTimeout(measure, 400);
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
      ro.disconnect();
    };
    // ключ собирает всё, от чего зависят линии
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lit = (l: { a: string; r: string }) => !focus || focus === l.a || focus === l.r;

  if (agents.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">
        {uk ? "У клієнта ще немає агентів." : "У клиента ещё нет агентов."}{" "}
        <Link href={`/clients/${clientId}/agents/new`} className="text-accent hover:underline">
          {uk ? "Створити агента" : "Создать агента"}
        </Link>
      </div>
    );

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Network className="size-4" />
        {uk ? "Агенти клієнта і спільні ресурси: лінія — агент користується ресурсом. Наведіть на вузол — побачите лише його зв'язки." : "Агенты клиента и общие ресурсы: линия — агент пользуется ресурсом. Наведите на узел — увидите только его связи."}
      </p>
      <div ref={root} className="relative">
        <svg className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" aria-hidden>
          {lines.map((l) => (
            <path key={l.id} d={l.d} fill="none" strokeWidth={lit(l) ? 2 : 1} className={lit(l) ? "stroke-accent/60" : "stroke-border/60"} />
          ))}
        </svg>
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-24">
          <div className="space-y-3">
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/agents/${a.id}/map`}
                data-agent={a.id}
                onMouseEnter={() => setFocus(a.id)}
                onMouseLeave={() => setFocus(null)}
                className={cx("block rounded-2xl border bg-surface p-3 transition hover:border-accent/50", focus === a.id ? "border-accent" : "border-border")}
              >
                <div className="flex items-center gap-2">
                  <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-lg">{a.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{a.name}</span>
                    <span className="block text-xs text-muted">
                      {a.status === "active" ? (uk ? "активний" : "активен") : a.status === "paused" ? (uk ? "на паузі" : "на паузе") : uk ? "чернетка" : "черновик"} · {uk ? `розмов за 7 днів: ${a.conversations}` : `разговоров за 7 дней: ${a.conversations}`}
                    </span>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {a.channels.length === 0 && <span className="text-xs text-amber-600 dark:text-amber-400">{uk ? "немає каналів" : "нет каналов"}</span>}
                  {a.channels.map((c, i) => (
                    <span key={i} className="flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-2 pl-0.5 text-xs" title={c.name}>
                      <ChannelIcon type={c.type} name={c.name} enabled={c.enabled} size={18} className="rounded-full" />
                      {CHANNEL_LABEL[c.type] ?? c.type}
                    </span>
                  ))}
                </div>
              </Link>
            ))}
            <Link href={`/clients/${clientId}/agents/new`} className="flex items-center gap-2 rounded-2xl border border-dashed border-border px-3 py-2 text-sm text-muted transition hover:border-accent/50 hover:text-text">
              <Plus className="size-4" />
              {uk ? "Новий агент" : "Новый агент"}
            </Link>
          </div>
          <div className="space-y-2">
            {resources.map((r) => (
              <Link
                key={r.key}
                href={r.href}
                data-res={r.key}
                onMouseEnter={() => setFocus(r.key)}
                onMouseLeave={() => setFocus(null)}
                className={cx("flex items-center gap-2 rounded-xl border bg-surface px-3 py-2 text-sm transition hover:border-accent/50", focus === r.key ? "border-accent" : "border-border")}
              >
                <Dot state={r.usedBy.length ? (r.ready ? "on" : "warn") : "off"} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.title}</span>
                  <span className={cx("block text-xs", r.usedBy.length === 0 || r.unused ? "text-amber-600 dark:text-amber-400" : "text-muted")}>
                    {r.usedBy.length === 0
                      ? uk
                        ? "жоден агент не користується"
                        : "ни один агент не пользуется"
                      : !r.ready
                        ? uk
                          ? "агенти користуються, але не налаштовано"
                          : "агенты пользуются, но не настроено"
                        : r.unused
                          ? uk
                            ? `не використовується: ${r.unused} з ${r.count}`
                            : `не используется: ${r.unused} из ${r.count}`
                          : uk
                            ? `агентів: ${r.usedBy.length}`
                            : `агентов: ${r.usedBy.length}`}
                  </span>
                </span>
                {r.count > 0 && <span className="text-xs text-muted">{r.count}</span>}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
