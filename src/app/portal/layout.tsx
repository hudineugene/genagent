import { Suspense, type ReactNode } from "react";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/client";
import { Spinner } from "@/components/ui";

export const instant = false;

/** Кабинет клиента студии: своя простая оболочка (бренд студии — в шапке страницы). */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-dvh place-items-center text-muted">
          <Spinner className="size-6" />
        </div>
      }
    >
      <Shell>{children}</Shell>
    </Suspense>
  );
}

async function Shell({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}
