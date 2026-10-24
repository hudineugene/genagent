"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Plus, Search, Settings, Star } from "lucide-react";
import type { NavAgent, NavClient, NavCtx } from "@/app/actions/nav";
import { useI18n } from "@/lib/i18n/client";
import { NAV_ICONS, visibleNav, type NavIcon } from "@/lib/nav-icons";
import { ClientAvatar, cx } from "../ui";
import { useShell } from "./frame";

/**
 * Панель слева от содержимого (компьютер, от 1024 px): на общих страницах — клиенты с логотипами (избранные сверху,
 * поиск по имени), внутри клиента — его разделы и агенты, внутри агента — его вкладки и соседние агенты.
 */
export function ContextPanel({ studioName }: { studioName: string }) {
  const { panel } = useShell();
  const pathname = usePathname();
  // В «Диалогах» свои три колонки (список, переписка, карточка) — панель клиентов только сжимала бы их
  if (!panel || pathname.startsWith("/inbox")) return null;
  return (
    <aside data-tour="panel" className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border bg-surface/50 lg:flex">
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <span className="truncate font-display text-[15px] font-bold tracking-tight">{studioName}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [scrollbar-width:thin]">
        <Suspense fallback={<PanelSkeleton />}>
          <PanelBody />
        </Suspense>
      </div>
    </aside>
  );
}

/** Какой вид панели нужен по адресу и для какой записи. */
function expected(pathname: string): { kind: NavCtx["kind"]; id?: string } {
  const m = pathname.match(/^\/(agents|clients)\/([0-9a-f-]{36})/);
  if (!m) return { kind: "clients" };
  return { kind: m[1] === "agents" ? "agent" : "client", id: m[2] };
}

function PanelBody() {
  const { ctx } = useShell();
  const pathname = usePathname();
  const want = expected(pathname);
  // Данные прошлой вкладки той же записи годятся (без мигания); другой записи — заготовка, пока не придут новые
  const fits = ctx && ctx.kind === want.kind && (ctx.kind === "clients" || (ctx.kind === "client" ? ctx.client.id : ctx.agent.id) === want.id);
  if (!ctx || !fits) return <PanelSkeleton />;
  if (ctx.kind === "agent") return <AgentPanel ctx={ctx} pathname={pathname} />;
  if (ctx.kind === "client") return <ClientPanel ctx={ctx} pathname={pathname} />;
  return <ClientsPanel clients={ctx.clients} />;
}

function PanelSkeleton() {
  return (
    <div className="space-y-2.5 p-1">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <span className="skeleton size-7 shrink-0" />
          <span className="skeleton h-3.5 flex-1" style={{ maxWidth: `${60 + ((i * 37) % 35)}%` }} />
        </div>
      ))}
    </div>
  );
}

const FAV_KEY = "fav-clients";
const FAV_EVENT = "genagent:fav";
function readFav() {
  try {
    return localStorage.getItem(FAV_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}
function subscribeFav(onChange: () => void) {
  window.addEventListener(FAV_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(FAV_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Избранные клиенты — в этом браузере. */
function useFavorites() {
  const raw = useSyncExternalStore(subscribeFav, readFav, () => "[]");
  const set = useMemo(() => {
    try {
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set<string>();
    }
  }, [raw]);
  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
    } catch {}
    window.dispatchEvent(new Event(FAV_EVENT));
  };
  return { fav: set, toggle };
}

function Heading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-2 first:mt-0">
      <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">{children}</span>
      {action}
    </div>
  );
}

const row = "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition";
const rowActive = "bg-surface font-medium text-text shadow-[0_0_0_1px_var(--border)]";
const rowIdle = "text-muted hover:bg-surface hover:text-text";

function ClientsPanel({ clients }: { clients: NavClient[] }) {
  const { t } = useI18n();
  const { fav, toggle } = useFavorites();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const list = query ? clients.filter((c) => c.name.toLowerCase().includes(query)) : clients;
  const pinned = list.filter((c) => fav.has(c.id));
  const rest = list.filter((c) => !fav.has(c.id));
  return (
    <>
      {clients.length > 6 && (
        <label className="mb-2 flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-sm focus-within:border-accent">
          <Search className="size-3.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.shell.findClient} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted/70" />
        </label>
      )}
      {pinned.length > 0 && (
        <>
          <Heading>{t.shell.favorites}</Heading>
          {pinned.map((c) => (
            <ClientRow key={c.id} c={c} pinned onPin={() => toggle(c.id)} />
          ))}
        </>
      )}
      <Heading
        action={
          <Link href="/clients/new" aria-label={t.shell.newClient} title={t.shell.newClient} className="grid size-5 place-items-center rounded text-muted hover:bg-surface-2 hover:text-accent">
            <Plus className="size-3.5" />
          </Link>
        }
      >
        {t.nav.clients}
      </Heading>
      {rest.map((c) => (
        <ClientRow key={c.id} c={c} onPin={() => toggle(c.id)} />
      ))}
      {list.length === 0 && <p className="px-2 py-3 text-sm text-muted">{clients.length ? t.shell.noMatch : t.shell.noClients}</p>}
    </>
  );
}

function ClientRow({ c, pinned, onPin }: { c: NavClient; pinned?: boolean; onPin: () => void }) {
  const { t } = useI18n();
  return (
    <div className="group/row relative">
      <Link href={`/clients/${c.id}`} className={cx(row, rowIdle, "pr-14")}>
        <ClientAvatar id={c.id} v={c.logoV} name={c.name} color={c.color} size={26} />
        <span className="min-w-0 flex-1 truncate">{c.name}</span>
      </Link>
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
        {c.waiting > 0 && (
          <span title={`${c.waiting} ${t.shell.waiting}`} className="min-w-5 rounded-full bg-danger px-1.5 text-center text-[11px] leading-5 font-semibold text-white">
            {c.waiting}
          </span>
        )}
        <button
          type="button"
          onClick={onPin}
          aria-label={pinned ? t.shell.unpin : t.shell.pin}
          title={pinned ? t.shell.unpin : t.shell.pin}
          className={cx("grid size-6 place-items-center rounded-md transition hover:bg-surface-2", pinned ? "text-amber-500" : "text-muted opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")}
        >
          <Star className={cx("size-3.5", pinned && "fill-current")} />
        </button>
      </span>
    </div>
  );
}

function ClientHead({ c, href, settings }: { c: NavClient & { industry: string }; href?: string; settings?: boolean }) {
  const { t } = useI18n();
  const body = (
    <>
      <ClientAvatar id={c.id} v={c.logoV} name={c.name} color={c.color} size={36} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{c.name}</span>
        {c.industry && <span className="block truncate text-xs text-muted">{c.industry}</span>}
      </span>
    </>
  );
  return (
    <>
      <Link href="/clients" className="mb-2 inline-flex items-center gap-1.5 px-2 text-xs text-muted transition hover:text-text">
        <ArrowLeft className="size-3.5" />
        {t.shell.allClients}
      </Link>
      <div className="relative mb-1 overflow-hidden rounded-xl border border-border bg-metal">
        <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: c.color }} />
        <div className="flex items-center gap-2.5 px-2.5 pt-3.5 pb-2.5">
          {href ? (
            <Link href={href} className="flex min-w-0 flex-1 items-center gap-2.5 hover:opacity-90">
              {body}
            </Link>
          ) : (
            body
          )}
          {settings && (
            <Link href={`/clients/${c.id}/edit`} aria-label={t.client.settings} title={t.client.settings} className="grid size-7 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text">
              <Settings className="size-4" />
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

function ClientPanel({ ctx, pathname }: { ctx: Extract<NavCtx, { kind: "client" }>; pathname: string }) {
  const { t } = useI18n();
  const params = useSearchParams();
  const base = `/clients/${ctx.client.id}`;
  const onMain = pathname === base;
  const active = onMain ? params.get("tab") || "agents" : "";
  const nav = visibleNav(ctx.nav, active);
  return (
    <>
      <ClientHead c={ctx.client} settings />
      <nav aria-label={t.shell.sections}>
        {nav.map((g, i) => (
          <div key={i}>
            {g.title && <Heading>{g.title}</Heading>}
            {g.items.map(({ key, label, icon, n, alert }) => (
              <SectionLink key={key} href={key === "agents" ? base : `${base}?tab=${key}`} label={label} icon={icon} tone={g.tone} active={active === key} n={n} alert={alert} replace={onMain} />
            ))}
          </div>
        ))}
      </nav>
      <AgentList agents={ctx.agents} clientId={ctx.client.id} current="" />
    </>
  );
}

function SectionLink({ href, label, icon, tone, active, n, alert, replace }: { href: string; label: string; icon: NavIcon; tone: string; active: boolean; n?: number; alert?: number; replace?: boolean }) {
  const Icon = NAV_ICONS[icon];
  return (
    <Link href={href} replace={replace} aria-current={active ? "page" : undefined} className={cx(row, active ? rowActive : rowIdle)}>
      <span className={cx("grid size-6 shrink-0 place-items-center rounded-md", tone)}>
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {alert ? <span className="min-w-5 rounded-full bg-danger px-1.5 text-center text-[11px] leading-5 font-semibold text-white">{alert}</span> : n ? <span className="text-xs text-muted tabular-nums">{n}</span> : null}
    </Link>
  );
}

const STATUS_DOT = { active: "bg-success", paused: "bg-amber-500", draft: "bg-muted/50" } as const;

function AgentList({ agents, clientId, current }: { agents: NavAgent[]; clientId: string; current: string }) {
  const { t } = useI18n();
  return (
    <>
      <Heading
        action={
          <Link href={`/clients/${clientId}/agents/new`} aria-label={t.shell.newAgent} title={t.shell.newAgent} className="grid size-5 place-items-center rounded text-muted hover:bg-surface-2 hover:text-accent">
            <Plus className="size-3.5" />
          </Link>
        }
      >
        {t.shell.agents}
      </Heading>
      {agents.map((a) => (
        <Link key={a.id} href={`/agents/${a.id}`} aria-current={a.id === current ? "page" : undefined} className={cx(row, a.id === current ? rowActive : rowIdle)}>
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-sm leading-none">{a.icon}</span>
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <span className={cx("size-1.5 shrink-0 rounded-full", STATUS_DOT[a.status])} title={t.status[a.status]} />
        </Link>
      ))}
    </>
  );
}

function AgentPanel({ ctx, pathname }: { ctx: Extract<NavCtx, { kind: "agent" }>; pathname: string }) {
  const { t } = useI18n();
  const { agent } = ctx;
  const base = `/agents/${agent.id}`;
  const tabs: { href: string; label: string; icon: NavIcon; n?: number; alert?: number }[] = [
    { href: base, label: t.channels.setupTab, icon: "sliders" },
    { href: `${base}/map`, label: t.help.mapTab, icon: "network" },
    { href: `${base}/channels`, label: t.channels.tab, icon: "radio", n: agent.channels || undefined },
    { href: `${base}/tests`, label: t.tests.tab, icon: "flask" },
    { href: `${base}/gaps`, label: t.gaps.tab, icon: "question", n: agent.gaps || undefined },
    { href: `${base}/review`, label: t.review.tab, icon: "sparkles", n: agent.proposals || undefined },
  ];
  return (
    <>
      <ClientHead c={ctx.client} href={`/clients/${ctx.client.id}`} />
      <div className="mt-3 mb-1 flex items-center gap-2.5 px-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-lg leading-none">{agent.icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{agent.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className={cx("size-1.5 rounded-full", STATUS_DOT[agent.status])} />
            {t.status[agent.status]}
          </span>
        </span>
      </div>
      <nav className="mt-2">
        {tabs.map((x) => (
          <SectionLink key={x.href} href={x.href} label={x.label} icon={x.icon} tone="bg-accent/10 text-accent" active={x.href === base ? pathname === base : pathname.startsWith(x.href)} n={x.n} alert={x.alert} />
        ))}
      </nav>
      {ctx.agents.length > 1 && <AgentList agents={ctx.agents} clientId={ctx.client.id} current={agent.id} />}
    </>
  );
}
