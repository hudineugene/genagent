import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentEvents, channels, conversations, messages, type ApiConfig } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";

/**
 * Очередь для своего бота — то, что студия сделала в «Диалогах» и что бот должен выполнить своим именем:
 *  • comment — ответ агента/менеджера в комментариях канала (бот публикует в ветке): { chatId, replyTo, text };
 *  • dm — ответ менеджера клиенту в чате бота: { userId, text };
 *  • resume — менеджер вернул клиента агенту (бот снова передаёт его вопросы ИИ): { userId };
 *  • followup — напоминание клиенту, который поговорил с агентом и ушёл ни с чем: { userId, text }
 *    (бот отправляет по своим правилам: не тем, кто отписался или уже оформил заказ; иначе подтверждает с error).
 * Бот запрашивает нужные виды: GET ?kinds=dm,resume (по умолчанию — только comment, как раньше),
 * выполняет и подтверждает: POST { id, messageId } или { id, error }.
 */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const KINDS = ["comment", "dm", "resume", "followup"] as const;

export async function GET(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const asked = (new URL(req.url).searchParams.get("kinds") ?? "comment").split(",").map((k) => k.trim());
  const kinds = KINDS.filter((k) => asked.includes(k));

  // Бот забирает ответы менеджера — значит, из «Диалогов» можно писать его клиентам (показываем поле ответа).
  if (kinds.includes("dm") && !(channel.config as ApiConfig).dmAt) {
    await db.update(channels).set({ config: { ...(channel.config as ApiConfig), dmAt: Date.now() } }).where(eq(channels.id, channel.id));
  }

  const conds = [];
  if (kinds.includes("comment")) {
    conds.push(and(eq(conversations.kind, "comment"), inArray(messages.role, ["assistant", "operator"])));
  }
  if (kinds.includes("dm")) conds.push(and(ne(conversations.kind, "comment"), eq(messages.role, "operator")));
  if (kinds.includes("followup")) {
    conds.push(and(ne(conversations.kind, "comment"), eq(messages.role, "assistant"), sql`json_extract(${messages.meta}, '$.followUp') = 1`));
  }
  if (kinds.includes("resume")) {
    conds.push(and(ne(conversations.kind, "comment"), eq(messages.role, "system"), eq(messages.text, "returned")));
  }
  if (!conds.length) return Response.json({ items: [] });

  const rows = await db
    .select({ id: messages.id, role: messages.role, text: messages.text, kind: conversations.kind, externalId: conversations.externalId, context: conversations.context })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.channelId, channel.id),
        eq(messages.status, "sent"),
        isNull(messages.externalId),
        gt(messages.createdAt, new Date(Date.now() - MAX_AGE_MS)),
        or(...conds),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(20);

  type Item = { id: string; kind: "comment" | "dm" | "resume" | "followup"; chatId?: string; replyTo?: string | null; userId?: string; text?: string };
  return Response.json({
    items: rows.flatMap((r): Item[] => {
      if (r.kind === "comment") {
        return r.context?.chatId ? [{ id: r.id, kind: "comment", chatId: r.context.chatId, replyTo: r.context.replyToId ?? null, text: r.text }] : [];
      }
      if (r.role === "system") return [{ id: r.id, kind: "resume", userId: r.externalId }];
      return [{ id: r.id, kind: r.role === "assistant" ? "followup" : "dm", userId: r.externalId, text: r.text }];
    }),
  });
}

const ackSchema = z.object({
  id: z.string().uuid(),
  messageId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)).optional(),
  done: z.boolean().optional(),
  error: z.string().max(300).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = ackSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.messageId && !parsed.data.done && !parsed.data.error)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const { id, messageId, done, error } = parsed.data;

  const [m] = await db
    .select({ id: messages.id, meta: messages.meta, conversationId: messages.conversationId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.id, id), eq(conversations.channelId, channel.id)));
  if (!m) return Response.json({ error: "not_found" }, { status: 404 });
  if (messageId || done) {
    await db.update(messages).set({ externalId: messageId ?? "done" }).where(eq(messages.id, id));
    // Напоминание дошло до клиента — для отчёта (результатом не считается).
    if (m.meta?.followUp && messageId) {
      const [conv] = await db.select({ externalId: conversations.externalId }).from(conversations).where(eq(conversations.id, m.conversationId));
      if (conv) await db.insert(agentEvents).values({ agentId: channel.agentId, clientId: channel.clientId, channelId: channel.id, conversationId: m.conversationId, externalUserId: conv.externalId, type: "followup_sent", label: "Напоминание отправлено", assisted: true });
    }
  } else if (m.meta?.followUp) {
    // Напоминание бот не отправил по своим правилам (уже есть заказ, отписался…) — это не сбой.
    await db.update(messages).set({ externalId: "skipped", status: "rejected", meta: { ...m.meta, error: `followup_skipped: ${error}` } }).where(eq(messages.id, id));
  } else {
    // Не получилось (клиент заблокировал бота, комментарий удалили…) — снимаем с очереди и зовём менеджера.
    await db
      .update(messages)
      .set({ externalId: "failed", meta: { ...m.meta, error: `publish_failed: ${error}` } })
      .where(eq(messages.id, id));
    await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, m.conversationId));
  }
  return Response.json({ ok: true });
}
