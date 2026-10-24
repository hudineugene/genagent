import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { LogOut } from "lucide-react";
import { logout } from "@/app/actions/auth";
import { Card, PageHeader, buttonClass } from "@/components/ui";
import { LocaleSwitch, ThemeSwitch } from "@/components/sidebar";
import { ProfileForms } from "./forms";
import { TwoFactor } from "./two-factor";
import { AvatarCard } from "./avatar";
import { avatarVersions } from "@/lib/avatar";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export default async function ProfilePage() {
  const { t } = await getT();
  const me = await requireUser();
  const [u] = await db.select({ totp: users.totpEnabled }).from(users).where(eq(users.id, me.id));
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t.profile.title} />
      <AvatarCard userId={me.id} name={me.name} version={(await avatarVersions()).get(me.id) ?? 0} />
      <ProfileForms name={me.name} email={me.email} />
      <div className="mt-6">
        <TwoFactor enabled={Boolean(u?.totp)} />
      </div>
      {/* Язык, тема и выход — на телефоне в меню их нет */}
      <Card className="mt-6 flex flex-wrap items-center gap-3 p-5">
        <span className="text-sm font-medium">{t.nav.language}</span>
        <LocaleSwitch />
        <span className="ml-2 text-sm font-medium">{t.nav.theme}</span>
        <ThemeSwitch />
        <form action={logout} className="ml-auto">
          <button className={buttonClass("danger", "sm")}>
            <LogOut className="size-4" />
            {t.nav.logout}
          </button>
        </form>
      </Card>
    </div>
  );
}

// Внутренний инструмент: страница всегда читает свежие данные из БД.
export const instant = false;
