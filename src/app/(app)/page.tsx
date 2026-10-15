import Link from "next/link";
import { desc, eq, count } from "drizzle-orm";
import { Plus } from "lucide-react";
import { db } from "@/db";
import { agents, clients } from "@/db/schema";
import { getT } from "@/lib/i18n/server";
import { Card, ClientAvatar, PageHeader, buttonClass } from "@/components/ui";

export default async function ClientsPage() {
  const { t } = await getT();
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      industry: clients.industry,
      color: clients.color,
      agents: count(agents.id),
    })
    .from(clients)
    .leftJoin(agents, eq(agents.clientId, clients.id))
    .groupBy(clients.id)
    .orderBy(desc(clients.createdAt));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t.clients.title}
        subtitle={t.clients.subtitle}
        actions={
          <Link href="/clients/new" className={buttonClass()}>
            <Plus className="size-4" />
            {t.clients.new}
          </Link>
        }
      />

      {rows.length === 0 ? (
        <Card className="grid place-items-center gap-4 border-dashed px-6 py-16 text-center">
          <p className="max-w-sm text-sm text-muted">{t.clients.empty}</p>
          <Link href="/clients/new" className={buttonClass()}>
            <Plus className="size-4" />
            {t.clients.new}
          </Link>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((c) => (
            <Link key={c.id} href={`/clients/${c.id}`} className="group">
              <Card className="flex h-full items-center gap-4 p-5 transition group-hover:border-accent/50 group-hover:shadow-lg group-hover:shadow-black/5">
                <ClientAvatar name={c.name} color={c.color} size={48} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{c.name}</div>
                  <div className="truncate text-sm text-muted">{c.industry || "—"}</div>
                  <div className="mt-1 text-xs text-muted">
                    {c.agents} {t.clients.agents}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
