import { notFound } from "next/navigation";
import { connection } from "next/server";
import { asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, kbSources } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { AgentTabs } from "./tabs";
import { agentConfigSchema } from "@/lib/agent/types";
import { getGoogleSettings } from "@/lib/google/calendar";
import { BackLink } from "@/components/back-link";
import { AgentStudio } from "./studio";

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  await connection();
  const [row] = await db
    .select({ agent: agents, client: clients })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  if (!row) notFound();
  const { agent, client } = row;

  const { t } = await getT();
  const [{ n: channelCount }] = await db.select({ n: count() }).from(channels).where(eq(channels.agentId, agent.id));
  const sources = await db
    .select({ id: kbSources.id, title: kbSources.title, type: kbSources.type, status: kbSources.status, chars: kbSources.chars })
    .from(kbSources)
    .where(eq(kbSources.clientId, client.id))
    .orderBy(asc(kbSources.createdAt));

  // Старые конфигурации дополняем полями по умолчанию (например, kbSourceIds).
  const parsed = agentConfigSchema.safeParse(agent.config);
  const config = parsed.success ? parsed.data : agent.config;

  return (
    <div className="mx-auto max-w-[1400px]">
      <BackLink href={`/clients/${client.id}`} label={client.name} />
      <AgentTabs agentId={agent.id} active="setup" channels={channelCount} t={t} />
      <AgentStudio
        agent={{ id: agent.id, name: agent.name, status: agent.status, version: agent.version, config }}
        client={{
          id: client.id,
          name: client.name,
          industry: client.industry,
          website: client.website,
          description: client.description,
          brandVoice: client.brandVoice,
        }}
        sources={sources}
        googleEmail={(await getGoogleSettings())?.clientEmail ?? null}
      />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
