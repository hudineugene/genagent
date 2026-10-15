import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { LogOut } from "lucide-react";
import { logout } from "@/app/actions/auth";
import { Card, PageHeader, buttonClass } from "@/components/ui";
import { LocaleSwitch, ThemeSwitch } from "@/components/sidebar";
import { ProfileForms } from "./forms";

export default async function ProfilePage() {
  const { t } = await getT();
  const me = await requireUser();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t.profile.title} subtitle={t.profile.subtitle} />
      <ProfileForms name={me.name} email={me.email} />
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
