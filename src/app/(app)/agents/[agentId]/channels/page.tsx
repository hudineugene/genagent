import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients } from "@/db/schema";
import { isPolling } from "@/lib/channels/telegram-poller";
import { requireUser } from "@/lib/auth";
import { getMetaSettings, publicUrl } from "@/lib/settings";
import { ChannelsManager, type ChannelItem } from "./manager";
import { inboundStale, lastInbound, webhookTimes } from "@/lib/channels/health";

export default async function AgentChannelsPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const user = await requireUser();
  const [row] = await db
    .select({ agent: agents, clientId: clients.id, clientName: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();
  const { agent } = row;

  const list = await db.select().from(channels).where(eq(channels.agentId, agentId)).orderBy(asc(channels.createdAt));
  const [inbound, hooks] = await Promise.all([lastInbound(list.map((c) => c.id)), webhookTimes()]);
  // Токен бота в браузер не отдаём.
  const items: ChannelItem[] = list.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    enabled: c.enabled,
    error: c.error,
    live: c.type === "telegram" ? isPolling(c.id) : c.enabled,
    lastInboundAt: inbound.get(c.id) ?? null,
    webhookAt: hooks[c.id] ?? null,
    inboundStale: inboundStale(inbound.get(c.id)),
    username: "username" in c.config ? c.config.username : null,
    widget: "color" in c.config ? c.config : null,
    whatsapp: c.type === "whatsapp" && "phoneNumberId" in c.config ? { phone: c.config.displayPhone, name: c.config.verifiedName ?? "" } : null,
    social:
      c.type === "instagram" || c.type === "threads"
        ? {
            dm: "dm" in c.config ? c.config.dm : undefined,
            comments: "comments" in c.config ? c.config.comments : undefined,
            approval: "approval" in c.config ? Boolean(c.config.approval) : false,
            tokenExpiresAt: "tokenExpiresAt" in c.config ? c.config.tokenExpiresAt : 0,
          }
        : null,
    api: c.type === "api" && "key" in c.config ? { key: c.config.key, label: c.config.label, approval: c.config.approval ?? true, botNote: c.config.botNote ?? "", followUps: Boolean(c.config.followUps), orderNotes: Boolean(c.config.orderNotes), ratingInvite: Boolean(c.config.ratingInvite) } : null,
    telegram:
      c.type === "telegram" && "botName" in c.config
        ? { comments: Boolean(c.config.comments), approval: c.config.approval ?? true, group: c.config.group ?? null }
        : null,
    email:
      c.type === "email" && "address" in c.config
        ? { address: c.config.address, approval: c.config.approval, fromName: c.config.fromName }
        : null,
  }));
  const meta = await getMetaSettings();
  const socialReady = {
    publicUrl: Boolean(publicUrl()),
    instagram: Boolean(meta.instagram),
    threads: Boolean(meta.threads),
    whatsapp: Boolean(meta.whatsapp ?? meta.instagram),
  };

  return (
    <div className="max-w-4xl">
      <ChannelsManager
        agentId={agent.id}
        agentStatus={agent.status}
        channels={items}
        publicUrl={process.env.PUBLIC_URL ?? null}
        socialReady={socialReady}
        isAdmin={user.role === "admin"}
      />
    </div>
  );
}

export const instant = false;
