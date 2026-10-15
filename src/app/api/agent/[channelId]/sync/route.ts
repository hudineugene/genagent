import { z } from "zod";
import { apiChannel } from "@/lib/channels/api-auth";
import { upsertConversation } from "@/lib/conversations";
import { syncBotMessages } from "@/lib/channels/bot-sync";

/**
 * Журнал переписки своего бота (см. lib/channels/bot-sync): POST { user, items: [{ id, dir, by?, text, kind?, at }] }.
 * Бот шлёт всё, что пришло от клиента и ушло клиенту, пачками и с повтором при сбое — переписка в «Диалогах»
 * полная, даже если сообщение перехватил сценарий бота или GenAgent был недоступен. Повторы безопасны.
 */
const bodySchema = z.object({
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)),
    name: z.string().max(200).optional(),
    username: z.string().max(100).optional(),
  }),
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        dir: z.enum(["in", "out"]),
        by: z.enum(["agent", "manager", "bot"]).optional(),
        text: z.string().max(4000),
        kind: z.string().max(30).optional(),
        at: z.number().int().positive(),
        // превью картинки до ~300 КБ
        thumb: z.string().max(420_000).optional(),
        thumbType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { user, items } = parsed.data;
  // Время из будущего (сбитые часы бота) — не дальше «сейчас»
  const now = Date.now();
  // Пустой текст — только у вложения без подписи (фото, стикер без смайлика…): его показываем значком
  const clean = items.filter((i) => i.text.trim() || (i.kind && i.kind !== "text")).map((i) => ({ ...i, at: Math.min(i.at, now) }));

  const { conversation, created } = await upsertConversation(channel, user.id, {
    name: user.name?.trim() || undefined,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  const result = await syncBotMessages(conversation.id, clean, { fresh: created });
  return Response.json({ ok: true, conversationId: conversation.id, ...result });
}
