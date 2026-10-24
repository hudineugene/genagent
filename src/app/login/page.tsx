import { Suspense } from "react";
import { redirect } from "next/navigation";
import { findCurrentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/client";
import { LoginForm } from "./login-form";

export const instant = false;

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

async function Login() {
  const me = await findCurrentUser();
  if (me) redirect(me.role === "client" ? "/portal" : "/");
  const locale = await getLocale();
  return (
    <I18nProvider locale={locale}>
      <LoginForm />
    </I18nProvider>
  );
}
