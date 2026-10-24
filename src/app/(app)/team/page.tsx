import { asc, ne } from "drizzle-orm";
import { db } from "@/db";
import { clients, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "./team-manager";
import { avatarVersions } from "@/lib/avatar";
import { TestAccounts } from "./test-accounts";
import { getTestAccounts } from "@/lib/test-accounts";

export default async function TeamPage() {
  const { t } = await getT();
  const me = await requireAdmin();
  const members = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt, clientIds: users.clientIds, totp: users.totpEnabled })
    .from(users)
    .where(ne(users.role, "client"))
    .orderBy(asc(users.createdAt));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.team.title} />
      <TeamManager members={members} meId={me.id} avatars={Object.fromEntries(await avatarVersions())} clients={await db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name))} />
      <TestAccounts initial={(await getTestAccounts()).join("\n")} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
