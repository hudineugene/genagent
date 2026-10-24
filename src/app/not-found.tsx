import Link from "next/link";
import { Suspense } from "react";
import { getT } from "@/lib/i18n/server";
import { ErrorScreen } from "@/components/error-screen";
import { BrandMark } from "@/components/brand";
import { buttonClass } from "@/components/ui";

/** «Не найдено» для любого адреса вне программы: знак GenAgent и переход на главную. */
export default function NotFound() {
  return (
    <div className="min-h-dvh">
      <div className="flex justify-center pt-10">
        <BrandMark size={44} />
      </div>
      <Suspense>
        <Body />
      </Suspense>
    </div>
  );
}

async function Body() {
  const { t } = await getT();
  return (
    <ErrorScreen code="404" title={t.shell.notFoundTitle} text={t.shell.notFoundText}>
      <Link href="/" className={buttonClass()}>
        {t.shell.home}
      </Link>
    </ErrorScreen>
  );
}
