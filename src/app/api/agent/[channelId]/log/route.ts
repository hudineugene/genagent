import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";
import { addMessage, upsertConversation } from "@/lib/conversations";

/**
 * Свой бот сообщает, что произошло в разговоре без агента, — чтобы в «Диалогах» была вся переписка:
 *  • user — клиент написал, пока его ведёт менеджер (агенту не отправлялось);
 *  • operator — менеджер ответил клиенту в самом боте (диалог у менеджера);
 *  • returned — менеджер в боте вернул клиента ИИ;
 *  • media — клиент прислал не текст (стикер, фото, голосовое…), text — подпись вроде «Стикер». Режим диалога
 *    не меняем; у менеджера — как обычное сообщение клиента (с уведомлением), у агента — просто строка в истории.
 * Агент на эти события не отвечает. externalId «bot» — чтобы очередь /outbox не отправила их обратно в бот.
 */
const bodySchema = z.object({
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)),
    name: z.string().max(200).optional(),
    username: z.string().max(100).optional(),
  }),
  role: z.enum(["user", "operator", "returned", "media"]),
  text: z.string().trim().max(4000).default(""),
  /** Номер сообщения в журнале переписки бота (см. /sync) — чтобы журнал не записал его второй раз */
  messageId: z.string().min(1).max(120).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { user, role, text, messageId } = parsed.data;
  if (role !== "returned" && !text) return Response.json({ error: "bad_request", details: "text required" }, { status: 400 });

  const { conversation } = await upsertConversation(channel, user.id, {
    name: user.name?.trim() || undefined,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  if (role === "media") {
    const label = `[${text}]`;
    const m = await addMessage(conversation.id, "user", label, { externalId: "bot", botId: messageId });
    if (conversation.mode !== "ai") {
      await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, conversation.id));
      void import("@/lib/notify/telegram").then((n) => n.notifyClientMessage(conversation.id, label, m.id));
    }
  } else if (role === "user") {
    const m = await addMessage(conversation.id, "user", text, { externalId: "bot", botId: messageId });
    await db.update(conversations).set({ mode: "human", needsAttention: true }).where(eq(conversations.id, conversation.id));
    // Сотруднику в Telegram — с кнопкой «Ответить» (если бот забирает ответы менеджера)
    void import("@/lib/notify/telegram").then((n) => n.notifyClientMessage(conversation.id, text, m.id));
  } else if (role === "operator") {
    await addMessage(conversation.id, "operator", text, { externalId: "bot", botId: messageId });
    await db.update(conversations).set({ mode: "human", needsAttention: false }).where(eq(conversations.id, conversation.id));
  } else if (conversation.mode !== "ai") {
    await db.update(conversations).set({ mode: "ai", needsAttention: false }).where(eq(conversations.id, conversation.id));
    await addMessage(conversation.id, "system", "returned", { externalId: "bot" });
  }
  return Response.json({ ok: true, conversationId: conversation.id });
}
