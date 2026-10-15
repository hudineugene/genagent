import Link from "next/link";
import { and, asc, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { MessagesSquare } from "lucide-react";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, users } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { isTyping } from "@/lib/conversations";
import { Card, PageHeader, cx } from "@/components/ui";
import { ConversationList, type ListItem } from "./list";
import { Thread, type ThreadData } from "./thread";
import { InboxPoller } from "./poller";

type Filter = "all" | "attention" | "human" | "closed";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; f?: string; client?: string }>;
}) {
  const sp = await searchParams;
  const { t } = await getT();
  const filter: Filter = (["all", "attention", "human", "closed"] as const).find((f) => f === sp.f) ?? "all";

  const where: SQL[] = [];
  if (filter === "attention") where.push(eq(conversations.needsAttention, true), ne(conversations.status, "closed"));
  if (filter === "human") where.push(eq(conversations.mode, "human"), ne(conversations.status, "closed"));
  if (filter === "closed") where.push(eq(conversations.status, "closed"));
  if (filter === "all") where.push(ne(conversations.status, "closed"));
  if (sp.client) where.push(eq(conversations.clientId, sp.client));

  const [rows, clientList, [{ attention }]] = await Promise.all([
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
      .where(and(...where))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(200),
    db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name)),
    db
      .select({ attention: sql<number>`count(*)` })
      .from(conversations)
      .where(and(eq(conversations.needsAttention, true), ne(conversations.status, "closed"))),
  ]);

  const thread = sp.c ? await loadThread(sp.c) : null;

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const next = { f: filter === "all" ? undefined : filter, client: sp.client, c: sp.c, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return `/inbox${s ? `?${s}` : ""}`;
  };

  const items: ListItem[] = rows.map((r) => ({ ...r, typing: isTyping(r.id), href: qs({ c: r.id }) }));

  return (
    <div className="mx-auto max-w-[1400px]">
      <InboxPoller />
      <PageHeader title={t.inbox.title} subtitle={t.inbox.subtitle} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["all", "attention", "human", "closed"] as const).map((f) => (
          <Link
            key={f}
            href={qs({ f: f === "all" ? undefined : f, c: undefined })}
            replace
            className={cx(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition",
              filter === f ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text",
            )}
          >
            {t.inbox.filters[f]}
            {f === "attention" && attention > 0 && (
              <span className="rounded-full bg-danger px-1.5 text-xs font-semibold text-white">{attention}</span>
            )}
          </Link>
        ))}
        {clientList.length > 1 && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Link
              href={qs({ client: undefined, c: undefined })}
              replace
              className={cx("rounded-full px-3 py-1.5 text-sm", !sp.client ? "bg-accent-soft text-accent" : "text-muted hover:text-text")}
            >
              {t.inbox.allClients}
            </Link>
            {clientList.map((c) => (
              <Link
                key={c.id}
                href={qs({ client: c.id, c: undefined })}
                replace
                className={cx(
                  "max-w-48 truncate rounded-full px-3 py-1.5 text-sm",
                  sp.client === c.id ? "bg-accent-soft text-accent" : "text-muted hover:text-text",
                )}
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      <Card className="grid h-[calc(100dvh-14rem)] min-h-[520px] overflow-hidden md:grid-cols-[340px_minmax(0,1fr)]">
        <div className={cx("min-h-0 border-border md:border-r", thread && "hidden md:block")}>
          {items.length === 0 ? (
            <div className="grid h-full place-items-center p-8 text-center text-sm text-muted">
              <div>
                <MessagesSquare className="mx-auto mb-3 size-8 opacity-40" />
                {t.inbox.empty}
              </div>
            </div>
          ) : (
            <ConversationList items={items} selectedId={sp.c} />
          )}
        </div>
        <div className={cx("min-h-0", !thread && "hidden md:block")}>
          {thread ? (
            <Thread data={thread} backHref={qs({ c: undefined })} />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted">{t.inbox.pick}</div>
          )}
        </div>
      </Card>
    </div>
  );
}

async function loadThread(id: string): Promise<ThreadData | null> {
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
  return {
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
  };
}

export const instant = false;
