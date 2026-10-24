"use client";

import Link from "next/link";
import { House, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { ErrorScreen } from "@/components/error-screen";
import { Button, buttonClass } from "@/components/ui";

/** Ошибка страницы внутри программы: меню остаётся, кнопка «Попробовать снова» перерисовывает страницу. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <ErrorScreen code="500" title={t.shell.errorTitle} text={t.shell.errorText}>
      <Button onClick={reset}>
        <RotateCcw className="size-4" />
        {t.shell.retry}
      </Button>
      <Link href="/" className={buttonClass("secondary")}>
        <House className="size-4" />
        {t.shell.home}
      </Link>
      {error.digest && <p className="w-full pt-2 font-mono text-xs text-muted">{error.digest}</p>}
    </ErrorScreen>
  );
}
