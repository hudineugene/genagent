import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { guardPage } from "@/lib/access";
import { getLocale } from "@/lib/i18n/server";
import { AgentReport } from "@/components/agent-map/report";

/** Отчёт-страница агента для печати в PDF (без меню студии). */
export default async function AgentReportPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  await requireUser();
  await guardPage("agent", agentId);
  const report = await AgentReport({ agentId, locale: await getLocale() });
  if (!report) notFound();
  return report;
}

export const instant = false;
