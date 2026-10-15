import Link from "next/link";
import type { ReactNode } from "react";
import { and, asc, desc, eq, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { ArrowRight, Bot, Building2, CheckCircle2, MessagesSquare, SearchX, X } from "lucide-react";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, users } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import type { Dict } from "@/lib/i18n";
import { isTyping } from "@/lib/conversations";
import { contactLabel, waited } from "@/lib/contact";
import { Card, cx } from "@/components/ui";
import { ConversationList, type ListItem } from "./list";
import { ContactAvatar } from "@/components/contact-avatar";
import { Thread, type ThreadData } from "./thread";
import { InboxPoller } from "./poller";
import { InboxToolbar } from "./toolbar";
import { InfoColumn } from "./info-panel";

type Filter = "all" | "attention" | "human" | "closed";
const FILTERS = ["all", "attention", "human", "closed"] as const;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; f?: string; client?: string; agent?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const { t, locale } = await getT();
  const filter: Filter = FILTERS.find((f) => f === sp.f) ?? "all";
  const q = (sp.q ?? "").trim().slice(0, 100);

  // Клиент и поиск — общие для всех вкладок (и для счётчиков на вкладках)
  const base: SQL[] = [];
  if (sp.client) base.push(eq(conversations.clientId, sp.client));
  if (sp.agent) base.push(eq(conversations.agentId, sp.agent));
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, "")}%`;
    base.push(
      or(
        like(conversations.contactName, pattern),
        like(conversations.contactHandle, pattern),
        like(conversations.lastMessageText, pattern),
        sql`exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.text} like ${pattern})`,
      )!,
    );
  }
  const byFilter: Record<Filter, SQL[]> = {
    all: [ne(conversations.status, "closed")],
    attention: [eq(conversations.needsAttention, true), ne(conversations.status, "closed")],
    human: [eq(conversations.mode, "human"), ne(conversations.status, "closed")],
    closed: [eq(conversations.status, "closed")],
  };

  const [rows, clientList, [counts], waitingTop] = await Promise.all([
    db
      .select({
        id: conversations.id,
        contactName: conversations.contactName,
        contactHandle: conversations.contactHandle,
        channelType: conversations.channelType,
        mode: conversations.mode,
        status: conversations.status,
        needsAttention: conversations.needsAttention,
        unread: conversations.unread,
        lastMessageText: conversations.lastMessageText,
        lastMessageAt: conversations.lastMessageAt,
        clientName: clients.name,
        clientColor: clients.color,
        agentName: agents.name,
      })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .where(and(...base, ...byFilter[filter]))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(200),
    db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name)),
    db
      .select({
        all: sql<number>`coalesce(sum(case when ${conversations.status} != 'closed' then 1 end), 0)`,
        attention: sql<number>`coalesce(sum(case when ${conversations.needsAttention} = 1 and ${conversations.status} != 'closed' then 1 end), 0)`,
        human: sql<number>`coalesce(sum(case when ${conversations.mode} = 'human' and ${conversations.status} != 'closed' then 1 end), 0)`,
        closed: sql<number>`coalesce(sum(case when ${conversations.status} = 'closed' then 1 end), 0)`,
      })
      .from(conversations)
      .where(base.length ? and(...base) : undefined),
    // Для пустой правой части: кто дольше всех ждёт человека
    sp.c
      ? Promise.resolve([])
      : db
          .select({
            id: conversations.id,
            contactName: conversations.contactName,
            contactHandle: conversations.contactHandle,
            channelType: conversations.channelType,
            lastMessageText: conversations.lastMessageText,
            lastMessageAt: conversations.lastMessageAt,
            clientName: clients.name,
          })
          .from(conversations)
          .innerJoin(clients, eq(clients.id, conversations.clientId))
          .where(and(eq(conversations.needsAttention, true), ne(conversations.status, "closed"), ...(sp.client ? [eq(conversations.clientId, sp.client)] : [])))
          .orderBy(asc(conversations.lastMessageAt))
          .limit(5),
  ]);

  // Недовольные — среди тех, кто ждёт человека
  const waitingIds = rows.filter((r) => r.needsAttention && r.status !== "closed").map((r) => r.id);
  const upset = new Set<string>();
  if (waitingIds.length) {
    for (const h of await db
      .select({ id: messages.conversationId, meta: messages.meta })
      .from(messages)
      .where(and(inArray(messages.conversationId, waitingIds), eq(messages.role, "system"), eq(messages.text, "handoff")))) {
      if (h.meta?.upset) upset.add(h.id);
    }
  }

  const thread = sp.c ? await loadThread(sp.c) : null;
  const agentFilter = sp.agent ? (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, sp.agent)))[0]?.name : undefined;

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { f: filter === "all" ? undefined : filter, client: sp.client, agent: sp.agent, q: q || undefined, c: sp.c, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return `/inbox${s ? `?${s}` : ""}`;
  };

  const items: ListItem[] = rows.map((r) => ({ ...r, upset: upset.has(r.id), typing: isTyping(r.id), href: qs({ c: r.id }) }));

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col md:h-[calc(100dvh-5rem)]">
      <InboxPoller />
      <div className={cx("mb-4 flex-wrap items-center gap-x-6 gap-y-3", thread ? "hidden md:flex" : "flex")}>
        <h1 className="text-2xl font-semibold tracking-tight">{t.inbox.title}</h1>
        <InboxToolbar clients={clientList} />
      </div>

      <div className={cx("mb-3 gap-1 overflow-x-auto [scrollbar-width:none]", thread ? "hidden md:flex" : "flex")}>
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={qs({ f: f === "all" ? undefined : f, c: undefined })}
            replace
            className={cx(
              "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition",
              filter === f ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {t.inbox.filters[f]}
            <span
              className={cx(
                "min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-semibold tabular-nums",
                f === "attention" && counts.attention > 0 ? "bg-danger text-white" : "bg-surface-2 text-muted",
              )}
            >
              {counts[f]}
            </span>
          </Link>
        ))}
        {agentFilter && (
          <Link
            href={qs({ agent: undefined, c: undefined })}
            replace
            className="ml-2 flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent"
            title="×"
          >
            {t.inbox.infoAgent}: {agentFilter}
            <X className="size-3.5" />
          </Link>
        )}
      </div>

      <Card className={cx("flex min-h-[480px]", thread ? "h-[calc(100dvh-7rem)]" : "h-[calc(100dvh-13rem)]", "overflow-hidden md:h-auto md:flex-1")}>
        <div className={cx("min-h-0 w-full shrink-0 border-border md:w-[320px] md:border-r", thread && "hidden md:block")}>
          {items.length === 0 ? (
            <div className="grid h-full place-items-center p-8 text-center text-sm text-muted">
              <div>
                {q || sp.client ? <SearchX className="mx-auto mb-3 size-8 opacity-40" /> : <MessagesSquare className="mx-auto mb-3 size-8 opacity-40" />}
                {q || sp.client ? t.inbox.notFound : t.inbox.empty}
              </div>
            </div>
          ) : (
            <ConversationList items={items} selectedId={sp.c} />
          )}
        </div>
        <div className={cx("min-h-0 min-w-0 flex-1", !thread && "hidden md:block")}>
          {thread ? (
            <Thread data={thread.data} backHref={qs({ c: undefined })} />
          ) : (
            <PickHint waiting={waitingTop} t={t} hrefFor={(id) => qs({ c: id })} />
          )}
        </div>
        {thread && (
          <InfoColumn>
            <ConversationInfo info={thread.info} data={thread.data} t={t} locale={locale} />
          </InfoColumn>
        )}
      </Card>
    </div>
  );
}

type Info = {
  clientId: string;
  createdAt: Date;
  total: number;
  fromContact: number;
  cost: number;
  linked: boolean;
  language: string | null;
};

async function loadThread(id: string): Promise<{ data: ThreadData; info: Info } | null> {
  const [row] = await db
    .select({
      conversation: conversations,
      clientName: clients.name,
      agentId: agents.id,
      agentName: agents.name,
      agentIcon: sql<string>`json_extract(${agents.config}, '$.icon')`,
      channelName: channels.name,
      channelConfig: channels.config,
    })
    .from(conversations)
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, id));
  if (!row) return null;

  const msgs = await db
    .select({
      id: messages.id,
      role: messages.role,
      text: messages.text,
      meta: messages.meta,
      status: messages.status,
      createdAt: messages.createdAt,
      author: users.name,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt), asc(sql`messages.rowid`));

  const c = row.conversation;
  const visible = msgs.filter((m) => m.role !== "system");
  return {
    data: {
      id: c.id,
      contactName: c.contactName,
      contactHandle: c.contactHandle,
      channelType: c.channelType,
      channelName: row.channelName,
      kind: c.kind,
      context: c.context ?? null,
      mode: c.mode,
      status: c.status,
      unread: c.unread,
      clientName: row.clientName,
      agentId: row.agentId,
      agentName: row.agentName,
      agentIcon: row.agentIcon ?? "🤖",
      // Свой бот: писать клиенту из «Диалогов» можно, если бот забирает ответы менеджера (или это комментарии).
      botReplies: c.channelType !== "api" || c.kind === "comment" || Boolean((row.channelConfig as { dmAt?: number }).dmAt),
      typing: isTyping(c.id),
      messages: msgs,
    },
    info: {
      clientId: c.clientId,
      createdAt: c.createdAt,
      total: visible.length,
      fromContact: visible.filter((m) => m.role === "user").length,
      cost: msgs.reduce((sum, m) => sum + (m.meta?.cost ?? 0), 0),
      linked: Boolean(c.context?.linkedFrom) || msgs.some((m) => m.meta?.fromSite),
      language: c.context?.language ?? null,
    },
  };
}

/** Правая часть, пока диалог не выбран: кто дольше всех ждёт ответа человека. */
function PickHint({
  waiting,
  t,
  hrefFor,
}: {
  waiting: { id: string; contactName: string; contactHandle: string; channelType: string; lastMessageText: string; lastMessageAt: Date; clientName: string }[];
  t: Dict;
  hrefFor: (id: string) => string;
}) {
  if (!waiting.length) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <span className="mx-auto mb-3 grid size-12 place-items-center rounded-full bg-success/10 text-success">
            <CheckCircle2 className="size-6" />
          </span>
          <p className="font-medium">{t.inbox.pickTitle}</p>
          <p className="mt-1 text-sm text-muted">{t.inbox.pickAllDone}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-md">
        <p className="mb-3 text-center text-sm font-medium text-muted">{t.inbox.pickWaiting}</p>
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {waiting.map((w) => {
            const label = contactLabel(w, t.inbox);
            return (
              <li key={w.id}>
                <Link href={hrefFor(w.id)} replace className="group flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2/60">
                  <ContactAvatar id={w.id} label={label} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{label}</span>
                    <span className="block truncate text-xs text-muted">
                      {w.clientName} · {w.lastMessageText}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-danger tabular-nums">
                    {t.inbox.waits} {waited(w.lastMessageAt, t)}
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted/50 transition group-hover:text-accent" />
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ConversationInfo({ info, data, t, locale }: { info: Info; data: ThreadData; t: Dict; locale: string }) {
  const fmt = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const label = contactLabel(data, t.inbox);
  return (
    <div className="space-y-5 p-5 text-sm">
      <div className="flex flex-col items-center text-center">
        <ContactAvatar id={data.id} label={label} size={56} />
        <div className="mt-2 font-semibold">{label}</div>
        {data.contactHandle && data.contactName && <div className="text-xs text-muted">{data.contactHandle}</div>}
        {info.language && <div className="mt-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted uppercase">{info.language}</div>}
      </div>
      <dl className="space-y-2.5">
        <Row label={t.inbox.infoChannel}>{data.channelName === "Widget" ? t.channels.widget : data.channelName}</Row>
        <Row label={t.inbox.infoClient}>{data.clientName}</Row>
        <Row label={t.inbox.infoAgent}>
          {data.agentIcon} {data.agentName}
        </Row>
        <Row label={t.inbox.infoStarted}>{fmt.format(info.createdAt)}</Row>
        <Row label={t.inbox.infoMessages}>
          {info.total} <span className="text-muted">({info.fromContact} {t.inbox.infoFromClient})</span>
        </Row>
        {info.cost > 0 && <Row label={t.inbox.infoCost}>${info.cost.toFixed(3)}</Row>}
        {info.linked && <Row label={t.inbox.infoLinked}>✓</Row>}
      </dl>
      <div className="space-y-1.5 border-t border-border pt-4">
        <InfoLink href={`/agents/${data.agentId}`} icon={<Bot className="size-4" />}>
          {t.inbox.infoOpenAgent}
        </InfoLink>
        <InfoLink href={`/clients/${info.clientId}`} icon={<Building2 className="size-4" />}>
          {t.inbox.infoOpenClient}
        </InfoLink>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13px]">{children}</dd>
    </div>
  );
}

function InfoLink({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Link href={href} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted transition hover:bg-surface-2 hover:text-text">
      {icon}
      {children}
      <ArrowRight className="ml-auto size-3.5 opacity-50" />
    </Link>
  );
}

export const instant = false;
