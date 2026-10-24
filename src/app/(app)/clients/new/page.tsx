import { createClient } from "@/app/actions/clients";
import { getT } from "@/lib/i18n/server";
import { NewClientWizard } from "@/components/new-client-wizard";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/ui";

export default async function NewClientPage() {
  const { t } = await getT();
  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href="/clients" label={t.nav.clients} />
      <PageHeader title={t.clients.createTitle} />
      <NewClientWizard action={createClient} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
