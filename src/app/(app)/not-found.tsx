import Link from "next/link";
import { House } from "lucide-react";
import { getT } from "@/lib/i18n/server";
import { ErrorScreen } from "@/components/error-screen";
import { buttonClass } from "@/components/ui";

/** «Не найдено» внутри программы (удалённый клиент или агент, чужой адрес): в каркасе, с переходом на главную. */
export default async function NotFound() {
  const { t } = await getT();
  return (
    <ErrorScreen code="404" title={t.shell.notFoundTitle} text={t.shell.notFoundText}>
      <Link href="/" className={buttonClass()}>
        <House className="size-4" />
        {t.shell.home}
      </Link>
      <Link href="/clients" className={buttonClass("secondary")}>
        {t.nav.clients}
      </Link>
    </ErrorScreen>
  );
}
