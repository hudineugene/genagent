import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { deleteClient, updateClient } from "@/app/actions/clients";
import { getT } from "@/lib/i18n/server";
import { ClientForm } from "@/components/client-form";
import { BackLink } from "@/components/back-link";
import { ConfirmButton } from "@/components/confirm-button";
import { PageHeader } from "@/components/ui";

export default async function EditClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const { t } = await getT();
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href={`/clients/${client.id}`} label={client.name} />
      <PageHeader
        title={t.clients.editTitle}
        actions={<ConfirmButton action={deleteClient.bind(null, client.id)} label={t.common.delete} />}
      />
      <ClientForm action={updateClient.bind(null, client.id)} client={client} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
