import { createClient } from "@/app/actions/clients";
import { getT } from "@/lib/i18n/server";
import { ClientForm } from "@/components/client-form";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/ui";

export default async function NewClientPage() {
  const { t } = await getT();
  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href="/" label={t.nav.clients} />
      <PageHeader title={t.clients.createTitle} />
      <ClientForm action={createClient} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
