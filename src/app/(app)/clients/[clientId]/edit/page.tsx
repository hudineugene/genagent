import { notFound } from "next/navigation";
import { and, eq, gte, sum } from "drizzle-orm";
import { db } from "@/db";
import { clients, usageLog, users } from "@/db/schema";
import { KEY_KINDS, maskKey } from "@/lib/keys";
import { ClientKeys } from "./client-keys";
import { ClientPrivacy } from "./client-privacy";
import { OwnerLogins } from "./owner-logins";
import { ClientLogo } from "./client-logo";
import { readCustomLogo } from "@/lib/client-logo";
import { subprocessors } from "@/lib/dpa";
import { deleteClient, updateClient } from "@/app/actions/clients";
import { getT } from "@/lib/i18n/server";
import { ClientForm } from "@/components/client-form";
import { BackLink } from "@/components/back-link";
import { ConfirmButton } from "@/components/confirm-button";
import { PageHeader } from "@/components/ui";

import { guardPage } from "@/lib/access";
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

export default async function EditClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  await guardPage("client", clientId);
  const { t } = await getT();
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) notFound();
  // Ключи в браузер не уходят: форме — запись без них, разделу ключей — только маска
  const { apiKeys, ...safe } = client;
  const ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY", googleMaps: "GOOGLE_MAPS_API_KEY" } as const;
  const [{ own }] = await db
    .select({ own: sum(usageLog.cost) })
    .from(usageLog)
    .where(and(eq(usageLog.clientId, client.id), eq(usageLog.ownKey, true), gte(usageLog.createdAt, daysAgo(30))));

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href={`/clients/${client.id}`} label={client.name} />
      <PageHeader
        title={t.clients.editTitle}
        actions={<ConfirmButton action={deleteClient.bind(null, client.id)} label={t.common.delete} />}
      />
      <ClientForm action={updateClient.bind(null, client.id)} client={{ ...safe, apiKeys: {} }} />
      <ClientLogo clientId={client.id} hasCustom={Boolean(await readCustomLogo(client.id))} />
      <ClientKeys
        clientId={client.id}
        ownSpend={Number(own ?? 0)}
        keys={KEY_KINDS.map((kind) => ({ kind, masked: apiKeys[kind] ? maskKey(apiKeys[kind]) : null, studio: Boolean(process.env[ENV[kind]]) }))}
      />
      <OwnerLogins
        clientId={client.id}
        rows={(await db.select({ id: users.id, name: users.name, email: users.email, clientIds: users.clientIds }).from(users).where(eq(users.role, "client"))).filter((u) => u.clientIds?.includes(client.id))}
      />
      <ClientPrivacy clientId={client.id} retentionDays={client.retentionDays} subs={(await subprocessors(client.id)).map((s) => ({ name: s.name, purpose: s.purpose, location: s.location }))} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
