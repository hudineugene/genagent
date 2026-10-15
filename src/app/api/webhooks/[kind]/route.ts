import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { channels } from "@/db/schema";
import { getMetaSettings, publicUrl } from "@/lib/settings";
import { parseSignedRequest } from "@/lib/channels/meta/webhook";

/**
 * Обязательные для Meta адреса:
 *  - /api/webhooks/deauthorize  — владелец аккаунта отозвал доступ: выключаем каналы с этим аккаунтом;
 *  - /api/webhooks/data-deletion — запрос на удаление данных: удаляем каналы аккаунта вместе с перепиской.
 * (instagram и threads обрабатываются своими маршрутами — у них приоритет.)
 */
export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (kind !== "deauthorize" && kind !== "data-deletion") return new Response("Not found", { status: 404 });

  const form = await req.formData().catch(() => null);
  const signed = String(form?.get("signed_request") ?? "");
  const meta = await getMetaSettings();
  const payload =
    (meta.instagram && parseSignedRequest(signed, meta.instagram.appSecret)) ||
    (meta.threads && parseSignedRequest(signed, meta.threads.appSecret));
  if (!payload?.user_id) return new Response("Bad request", { status: 400 });
  const accountId = String(payload.user_id);

  const match = sql`(json_extract(${channels.config}, '$.igUserId') = ${accountId} OR json_extract(${channels.config}, '$.threadsUserId') = ${accountId})`;
  if (kind === "deauthorize") {
    const off = await db.update(channels).set({ enabled: false, error: "deauthorized" }).where(match).returning({ id: channels.id });
    const { notifyProblem } = await import("@/lib/notify/telegram");
    for (const ch of off) void notifyProblem(`channel:${ch.id}:deauthorized`, "deauthorized", { channelId: ch.id });
    return Response.json({ ok: true });
  }

  const deleted = await db.delete(channels).where(match).returning({ id: channels.id });
  const code = randomBytes(8).toString("hex");
  console.log(`data deletion for account ${accountId}: ${deleted.length} channel(s), code ${code}`);
  return Response.json({
    url: `${publicUrl() ?? ""}/api/webhooks/data-deletion?code=${code}`,
    confirmation_code: code,
  });
}

/** Страница статуса удаления (ссылка из ответа выше). */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (kind !== "data-deletion") return new Response("Not found", { status: 404 });
  const code = new URL(req.url).searchParams.get("code") ?? "";
  return new Response(
    `Запрос ${code.replace(/[^0-9a-f]/g, "")} выполнен: данные аккаунта удалены. / Запит виконано: дані акаунта видалено.`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

