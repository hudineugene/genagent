import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentEvents, conversations, messages } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";

/**
 * Свой бот сообщает о результате: клиент отправил бриф, оставил заявку, записался на просмотр, оплатил,
 * забронировал… — или оценил ответ агента (rating_up / rating_down). По событиям считается воронка агента:
 * «assisted» — у клиента был разговор с агентом за 14 дней до события.
 * Оценка ставится на последний ответ агента в разговоре; 👎 — разговор попадает в «Требуют внимания».
 */
const ASSIST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  user: z.object({ id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)) }),
  type: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  label: z.string().trim().max(120).optional(),
  value: z.number().finite().nonnegative().max(1e9).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { user, type, label, value } = parsed.data;

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.channelId, channel.id), eq(conversations.externalId, user.id)))
    .limit(1);
  let assisted = false;
  let lastReply: { id: string; meta: (typeof messages.$inferSelect)["meta"] } | undefined;
  if (conversation) {
    [lastReply] = await db
      .select({ id: messages.id, meta: messages.meta })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.role, "assistant"),
          gt(messages.createdAt, new Date(Date.now() - ASSIST_WINDOW_MS)),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    assisted = Boolean(lastReply);
  }

  if (type === "rating_up" || type === "rating_down") {
    if (!lastReply || !conversation) return Response.json({ ok: false, reason: "no_reply" });
    await db
      .update(messages)
      .set({ meta: { ...lastReply.meta, rating: type === "rating_up" ? "up" : "down" } })
      .where(eq(messages.id, lastReply.id));
    if (type === "rating_down") await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, conversation.id));
  }

  await db.insert(agentEvents).values({
    agentId: channel.agentId,
    clientId: channel.clientId,
    channelId: channel.id,
    conversationId: conversation?.id ?? null,
    externalUserId: user.id,
    type,
    label: label ?? "",
    value: value ?? null,
    assisted,
  });
  return Response.json({ ok: true, assisted });
}
