import { requireUser } from "@/lib/auth";
import { clientReport, clientReportHtml, previousMonth, reportFileName } from "@/lib/agent/report";

/**
 * Отчёт владельцу бизнеса за месяц (?month=YYYY-MM, по умолчанию — прошлый): HTML-страница для просмотра,
 * печати в PDF и пересылки. ?download=1 — скачать файлом. Только для сотрудников студии.
 */
export async function GET(req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  await requireUser();
  const { clientId } = await params;
  const url = new URL(req.url);
  const asked = url.searchParams.get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : previousMonth();
  const report = await clientReport(clientId, month);
  if (!report) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
  if (url.searchParams.get("download")) headers["Content-Disposition"] = `attachment; filename="${reportFileName(report, month).replace(/[^\x20-\x7e]/g, "_")}"`;
  return new Response(clientReportHtml(report), { headers });
}
