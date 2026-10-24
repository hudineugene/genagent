import { requireUser } from "@/lib/auth";
import { exportPerson } from "@/lib/privacy";

/** Выгрузка всех данных человека (GDPR, ст. 15 и 20): JSON-файл по всем его разговорам у клиента. */
export async function GET(_req: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  await requireUser();
  const { conversationId } = await params;
  const data = await exportPerson(conversationId);
  if (!data) return new Response("not found", { status: 404 });
  const name = `personal-data-${(data.person.name || "contact").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)}-${data.exportedAt.slice(0, 10)}.json`;
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
  });
}
