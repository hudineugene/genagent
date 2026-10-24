import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { canAccess } from "@/lib/access";

/** Все страницы клиента: сотрудник с ограниченным доступом видит только своих клиентов. */
export default async function ClientLayout({ children, params }: { children: ReactNode; params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!(await canAccess("client", clientId))) notFound();
  return children;
}
