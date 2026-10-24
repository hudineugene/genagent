import Link from "next/link";
import { ChevronRight, Clock, MessagesSquare, Wallet } from "lucide-react";
import type { ClientSummary } from "@/lib/dashboard";
import type { Dict } from "@/lib/i18n";
import { ClientAvatar, cx } from "./ui";
import { Spark } from "./spark";

/**
 * Карточка клиента: агенты со статусом, диалоги и расход за неделю, кто ждёт человека. Главная и «Клиенты».
 * trend — разговоры по дням за 14 дней (мини-график со стрелкой тренда в подвале).
 */
export function ClientCard({ client: c, t, trend }: { client: ClientSummary; t: Dict; trend?: number[] }) {
  return (
    <div
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface p-5 transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg hover:shadow-black/5"
      // Лёгкий градиент цвета клиента сверху — карточки разных клиентов различимы с одного взгляда
      style={{ backgroundImage: `linear-gradient(180deg, color-mix(in srgb, ${/^#[0-9a-f]{3,8}$/i.test(c.color) ? c.color : "var(--accent)"} 12%, transparent) 0, transparent 88px)` }}
    >
      <Link href={`/clients/${c.id}`} className="absolute inset-0 rounded-2xl" aria-label={c.name} />
      <div className="flex items-start gap-3.5">
        <ClientAvatar id={c.id} v={c.logoV} name={c.name} color={c.color} size={44} morph />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{c.name}</div>
          <div className="truncate text-sm text-muted">{c.industry || "—"}</div>
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted/60 transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </div>

      <div className="relative mt-4 flex flex-1 flex-wrap content-start gap-1.5">
        {c.agents.length === 0 && <span className="text-xs text-muted">{t.home.noAgents}</span>}
        {c.agents.map((a) => (
          <Link
            key={a.id}
            href={`/agents/${a.id}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-2 py-1 pr-2 pl-1.5 text-xs font-medium transition hover:bg-accent-soft hover:text-accent"
          >
            <span className="text-sm leading-none">{a.icon}</span>
            <span className="truncate">{a.name}</span>
            <span
              className={cx("size-1.5 shrink-0 rounded-full", a.status === "active" ? "bg-success" : a.status === "paused" ? "bg-amber-500" : "bg-muted/50")}
              title={a.status === "active" ? undefined : a.status === "paused" ? t.home.agentPaused : t.home.agentDraft}
            />
          </Link>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-4 border-t border-border pt-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1" title={`${c.conversations} ${t.home.conversations} ${t.home.perWeek}`}>
          <MessagesSquare className="size-3.5" />
          <b className="font-semibold text-text tabular-nums">{c.conversations}</b>
        </span>
        <span className="inline-flex items-center gap-1" title={`$${c.cost.toFixed(2)} ${t.home.perWeek}`}>
          <Wallet className="size-3.5" />
          <b className="font-semibold text-text tabular-nums">${c.cost.toFixed(2)}</b>
        </span>
        <span className="whitespace-nowrap text-muted/70">{t.home.perWeek}</span>
        <span className="ml-auto hidden sm:block">
          <Spark data={trend} />
        </span>
        {c.waiting > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-danger/10 sm:ml-0 px-2 py-0.5 font-semibold text-danger">
            <Clock className="size-3" />
            {c.waiting}
          </span>
        )}
      </div>
    </div>
  );
}
