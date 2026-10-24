import { Suspense, type ReactNode } from "react";
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/client";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/sidebar";
import { ShellFrame } from "@/components/shell/frame";
import { ContextPanel } from "@/components/shell/context-panel";
import { Topbar } from "@/components/shell/topbar";
import { Toaster } from "@/components/toast";
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
  const [user, locale] = await Promise.all([requireUser(), getLocale()]);
  // После проверки входа: страница уже динамическая, настройки читаются на каждый запрос
  const general = await (await import("@/lib/general")).getGeneral();
  const { inScope, scopeOf } = await import("@/lib/access");
  // Панель слева свёрнута или нет — из cookie, чтобы страница сразу рисовалась как надо
  const panel = (await cookies()).get("panel")?.value !== "off";
  const [{ attention }] = await db
    .select({ attention: count() })
    .from(conversations)
    .where(and(eq(conversations.isTest, false), eq(conversations.needsAttention, true), ne(conversations.status, "closed"), inScope(conversations.clientId, scopeOf(user))));
  return (
    <I18nProvider locale={locale} timeZone={general.timeZone}>
      <ShellFrame initialPanel={panel}>
        <Sidebar userName={user.name} isAdmin={user.role === "admin"} inboxBadge={attention} />
        <ContextPanel studioName={general.studioName || "GenAgent"} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="min-w-0 flex-1 px-4 pt-6 pb-24 md:px-6 md:py-7 lg:px-8">{children}</main>
        </div>
      </ShellFrame>
      <Toaster />
    </I18nProvider>
  );
}
