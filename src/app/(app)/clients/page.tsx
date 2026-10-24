import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { getT } from "@/lib/i18n/server";
import { scope } from "@/lib/access";
import { dashboardData } from "@/lib/dashboard";
import { ClientCard } from "@/components/client-card";
import { EmptyState, PageHeader, buttonClass } from "@/components/ui";

export default async function ClientsPage() {
  const { t } = await getT();
  const { clients } = await dashboardData(await scope());

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t.clients.title}
        actions={
          <Link href="/clients/new" className={buttonClass()}>
            <Plus className="size-4" />
            {t.clients.new}
          </Link>
        }
      />

      {clients.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          text={t.clients.empty}
          action={
            <Link href="/clients/new" className={buttonClass()}>
              <Plus className="size-4" />
              {t.clients.new}
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((c) => (
            <ClientCard key={c.id} client={c} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
