import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, studioTemplates } from "@/db/schema";
import { createFromTemplateAction } from "@/app/actions/studio-templates";
import { Card, buttonClass } from "@/components/ui";
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
  const templates = await db.select({ id: studioTemplates.id, name: studioTemplates.name, description: studioTemplates.description, version: studioTemplates.version }).from(studioTemplates);

  return (
    <div className="mx-auto max-w-5xl">
      <BackLink href={`/clients/${client.id}`} label={client.name} />
      <PageHeader title={t.newAgent.title} />
      {templates.length > 0 && (
        <Card className="mb-6 space-y-3 p-5">
          <div className="font-semibold">{t.studioTemplates.fromTemplate}</div>
          <p className="text-sm text-muted">{t.studioTemplates.fromTemplateHint}</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((x) => (
              <form key={x.id} action={createFromTemplateAction.bind(null, client.id, x.id)}>
                <button className={buttonClass("secondary", "sm")} title={x.description}>
                  {x.name} · v{x.version}
                </button>
              </form>
            ))}
          </div>
        </Card>
      )}
      <NewAgentWizard clientId={client.id} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
