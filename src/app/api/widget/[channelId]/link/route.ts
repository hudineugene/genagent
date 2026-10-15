import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channels, conversations, type WidgetConfig } from "@/db/schema";
import { widgetLinkToken } from "@/lib/channels/link";

/**
 * «Продолжить в Telegram» из окна чата на сайте: ссылка на бота клиента с одноразовым кодом разговора.
 * Бот передаёт код в GenAgent (/api/agent/{id}/link) — переписка с сайта продолжается в боте.
 */
const bodySchema = z.object({ visitor: z.string().uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.type, "widget"), eq(channels.enabled, true)));
  const bot = (channel?.config as WidgetConfig | undefined)?.telegramBot;
  if (!channel || !bot) return Response.json({ error: "not_found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.channelId, channelId), eq(conversations.externalId, parsed.data.visitor)));
  // Без разговора переносить нечего — просто ссылка на бота.
  if (!conversation) return Response.json({ url: `https://t.me/${bot}` });
  const token = await widgetLinkToken(conversation);
  return Response.json({ url: `https://t.me/${bot}?start=w_${token}` });
}
