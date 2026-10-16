import { Suspense, type ReactNode } from "react";
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/client";
import { Sidebar } from "@/components/sidebar";
import { Spinner } from "@/components/ui";

// Внутренний инструмент: все страницы зависят от сессии, мгновенная навигация не критична.
export const instant = false;

export default function AppLayout({ children }: { children: ReactNode }) {
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
  const [user, locale, [{ attention }]] = await Promise.all([
    requireUser(),
    getLocale(),
    db
      .select({ attention: count() })
      .from(conversations)
      .where(and(eq(conversations.isTest, false), eq(conversations.needsAttention, true), ne(conversations.status, "closed"))),
  ]);
  return (
    <I18nProvider locale={locale}>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <Sidebar userName={user.name} isAdmin={user.role === "admin"} inboxBadge={attention} />
        <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </I18nProvider>
  );
}
