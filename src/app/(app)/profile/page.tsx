import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { PageHeader } from "@/components/ui";
import { ProfileForms } from "./forms";

export default async function ProfilePage() {
  const { t } = await getT();
  const me = await requireUser();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t.profile.title} subtitle={t.profile.subtitle} />
      <ProfileForms name={me.name} email={me.email} />
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
