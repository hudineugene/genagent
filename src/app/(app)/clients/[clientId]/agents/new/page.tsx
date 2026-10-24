import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/ui";
import { NewAgentWizard } from "./wizard";

import { guardPage } from "@/lib/access";
export default async function NewAgentPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  await guardPage("client", clientId);
  const { t } = await getT();
  const [client] = await db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.id, clientId));
  if (!client) notFound();

  return (
    <div className="mx-auto max-w-5xl">
      <BackLink href={`/clients/${client.id}`} label={client.name} />
      <PageHeader title={t.newAgent.title} />
      <NewAgentWizard clientId={client.id} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
