import { and, asc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";
import { addMessage, isTyping, respond, upsertConversation } from "@/lib/conversations";

/**
 * Свой бот клиента спрашивает агента: POST с ключом канала (Authorization: Bearer …).
 * Отвечаем синхронно: { reply, handoff, summary, upset, actions }. upset — агент передал недовольного клиента (срочно). actions — служебные действия агента для бота
 * (метки [[ACTION тип: значение]] в правилах агента), например { type: "check", value: "Нурофен 200" }. reply = null — агент не ответил (выключен, ошибка, лимит):
 * бот поступает как раньше — передаёт сообщение менеджеру.
 */
const bodySchema = z.object({
  user: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)),
    name: z.string().max(200).optional(),
    username: z.string().max(100).optional(),
  }),
  text: z.string().trim().min(1).max(4000),
  /** Язык, на котором клиент пользуется ботом (ru, uk, en, es…) */
  language: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/).optional(),
  /** Что клиент сейчас открыл в боте — например, карточку объекта */
  context: z.string().max(2000).optional(),
});

const WAIT_LIMIT_MS = 90_000;

// Ответы, уже отданные боту: если клиент написал два сообщения подряд, один ответ агента не уйдёт дважды.
const g = globalThis as unknown as { __apiClaimed?: Set<string> };
const claimed = (g.__apiClaimed ??= new Set());

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!channel.enabled) return Response.json({ reply: null, handoff: false, reason: "channel_disabled" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { user, text, language, context } = parsed.data;

  const { conversation } = await upsertConversation(channel, user.id, {
    name: user.name?.trim() || undefined,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  await db
    .update(conversations)
    .set({ context: { ...conversation.context, language: language ?? conversation.context?.language, botContext: context || undefined } })
    .where(eq(conversations.id, conversation.id));
  // Бот сам решает, когда клиента ведёт менеджер. Раз он снова спрашивает агента — диалог вернулся к ИИ.
  if (conversation.mode === "human") {
    await db.update(conversations).set({ mode: "ai", needsAttention: false }).where(eq(conversations.id, conversation.id));
    await addMessage(conversation.id, "system", "returned", { externalId: "bot" });
  }
  const userMsg = await addMessage(conversation.id, "user", text);
  const [{ rowid: userRow }] = await db
    .select({ rowid: sql<number>`rowid` })
    .from(messages)
    .where(eq(messages.id, userMsg.id));

  // Отвечаем сразу, без паузы на «допишет ли клиент ещё»: бот ждёт ответ в этом же запросе.
  await respond(conversation.id);
  const started = Date.now();
  while (isTyping(conversation.id) && Date.now() - started < WAIT_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const after = await db
    .select({ id: messages.id, role: messages.role, text: messages.text, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), gt(sql`rowid`, userRow)))
    .orderBy(asc(sql`rowid`));
  const reply = after.find((m) => m.role === "assistant" && !claimed.has(m.id));
  const handoffMsg = after.find((m) => m.role === "system" && m.text === "handoff");
  const handoff = Boolean(handoffMsg) || Boolean(reply?.meta?.handoff);
  const summary = handoffMsg?.meta?.summary ?? null;
  // Клиент недоволен — бот может пометить заявку как срочную.
  const upset = Boolean(handoffMsg?.meta?.upset);
  if (!reply) {
    const reason = after.find((m) => m.role === "system" && m.meta?.error)?.text ?? (conversation.mode === "human" ? "manager_mode" : "no_reply");
    return Response.json({ reply: null, handoff, summary, upset, reason, conversationId: conversation.id });
  }
  claimed.add(reply.id);
  if (claimed.size > 10_000) claimed.clear();
  return Response.json({ reply: reply.text, handoff, summary, upset, actions: reply.meta?.actions ?? [], conversationId: conversation.id });
}
