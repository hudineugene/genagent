import { requireUser } from "@/lib/auth";
import { dpaHtml } from "@/lib/dpa";

import { canAccess } from "@/lib/access";
/** Шаблон договора обработки данных (DPA) клиента — страница для печати и сохранения в PDF. */
export async function GET(_req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  await requireUser();
  const { clientId } = await params;
  if (!(await canAccess("client", clientId))) return new Response("Forbidden", { status: 403 });
  const html = await dpaHtml(clientId);
  if (!html) return new Response("not found", { status: 404 });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
}
