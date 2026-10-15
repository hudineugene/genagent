import { asc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "./team-manager";

export default async function TeamPage() {
  const { t } = await getT();
  const me = await requireAdmin();
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users)
    .orderBy(asc(users.createdAt));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.team.title} subtitle={t.team.subtitle} />
      <TeamManager members={members} meId={me.id} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
