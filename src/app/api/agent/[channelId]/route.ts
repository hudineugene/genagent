import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, conversations, messages } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";
import { addMessage, isTyping, respond, upsertConversation } from "@/lib/conversations";
import { describePhoto, saveThumb } from "@/lib/media";
import { speechAvailable, synthesize } from "@/lib/speech";

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
  /** Текст клиента; у фото — подпись (может быть пустой) */
  text: z.string().trim().max(4000).default(""),
  /** Фото от клиента (до ~4 МБ): агент получит его описание и ответит с учётом того, что на фото */
  image: z
    .object({ data: z.string().min(100).max(5_600_000), mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg") })
    .optional(),
  /** Язык, на котором клиент пользуется ботом (ru, uk, en, es…) */
  language: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/).optional(),
  /** Что клиент сейчас открыл в боте — например, карточку объекта */
  context: z.string().max(2000).optional(),
  /** Номер этого сообщения в журнале переписки бота (см. /sync) — чтобы не записать его дважды */
  messageId: z.string().min(1).max(120).optional(),
  /**
   * Клиент написал несколько сообщений подряд: бот подождал, пока он допишет, и прислал предыдущие здесь
   * (по порядку), а последнее — в text. Сохраняем каждое отдельно, агент отвечает один раз на все.
   */
  earlier: z
    .array(z.object({ text: z.string().trim().min(1).max(4000), messageId: z.string().min(1).max(120).optional() }))
    .max(10)
    .optional(),
  /** Клиент спросил голосовым — ответить и голосом (если у агента включено и на сервере есть ключ OpenAI) */
  voiceReply: z.boolean().optional(),
  /** Расписание команды сейчас: открыто ли, когда откроются («завтра з 10:00»), за сколько минут обычно отвечают */
  team: z
    .object({ open: z.boolean(), next: z.string().trim().max(80).optional(), minutes: z.number().int().min(1).max(10080).optional() })
    .optional(),
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
  const { user, text, language, context, messageId, image, team, earlier, voiceReply } = parsed.data;
  if (!text && !image) return Response.json({ error: "bad_request", details: "text or image required" }, { status: 400 });

  const { conversation } = await upsertConversation(channel, user.id, {
    name: user.name?.trim() || undefined,
    handle: user.username ? `@${user.username.replace(/^@/, "")}` : undefined,
  });
  await db
    .update(conversations)
    .set({
      context: {
        ...conversation.context,
        language: language ?? conversation.context?.language,
        botContext: context || undefined,
        team: team ? { ...team, at: Date.now() } : conversation.context?.team,
      },
    })
    .where(eq(conversations.id, conversation.id));
  // Бот сам решает, когда клиента ведёт менеджер. Раз он снова спрашивает агента — диалог вернулся к ИИ.
  // Кроме случая, когда менеджер писал клиенту только что: бот мог ещё не узнать о его ответе (забирает ответы раз в
  // несколько секунд) — разговор остаётся у менеджера.
  if (conversation.mode === "human" && !(await operatorWroteWithin(conversation.id, 30 * 60 * 1000))) {
    await db.update(conversations).set({ mode: "ai", needsAttention: false }).where(eq(conversations.id, conversation.id));
    await addMessage(conversation.id, "system", "returned", { externalId: "bot" });
  }
  // Предыдущие сообщения пачки — до последнего; агент ответит один раз на все
  for (const e of earlier ?? []) await addMessage(conversation.id, "user", e.text, { botId: e.messageId });
  // Фото: дешёвая модель описывает, что на нём; описание — в сообщении клиента (агент его увидит), превью — в «Диалогах»
  const vision = image ? await describePhoto(image.data, image.mediaType, { agentId: channel.agentId, clientId: channel.clientId }, text) : null;
  const userMsg = await addMessage(conversation.id, "user", text, {
    botId: messageId,
    ...(image ? { meta: { kind: "photo", ...(vision ? { vision } : {}) } } : {}),
  });
  if (image) {
    // Сообщение уже могло прийти журналом (тот же номер) — дописываем описание и превью к нему
    const thumb = userMsg.meta?.thumb ?? (image.data.length <= 560_000 ? saveThumb(userMsg.id, image.data, image.mediaType) : null);
    await db
      .update(messages)
      .set({ meta: { ...(userMsg.meta ?? {}), kind: "photo", ...(vision ? { vision } : {}), ...(thumb ? { thumb } : {}) } })
      .where(eq(messages.id, userMsg.id));
  }
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
    .select({ id: messages.id, role: messages.role, text: messages.text, meta: messages.meta, status: messages.status })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), gt(sql`rowid`, userRow)))
    .orderBy(asc(sql`rowid`));
  // Только отправленный ответ: отклонённый проверкой фактов клиенту не уходит
  const reply = after.find((m) => m.role === "assistant" && m.status === "sent" && !claimed.has(m.id));
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
  // Голосовой ответ: OGG/Opus (формат голосовых Telegram) — бот шлёт его голосовым, текст — подписью
  let voice: { data: string; mimeType: string } | undefined;
  if (voiceReply && speechAvailable()) {
    const [agent] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, channel.agentId));
    const cfg = (agent?.config ?? {}) as { voiceReplies?: boolean; voice?: string };
    if (cfg.voiceReplies !== false) {
      const data = await synthesize(reply.text, {
        voice: cfg.voice,
        language: language ?? conversation.context?.language,
        agentId: channel.agentId,
        clientId: channel.clientId,
        conversationId: conversation.id,
      });
      if (data) {
        voice = { data, mimeType: "audio/ogg" };
        await db.update(messages).set({ meta: { ...(reply.meta ?? {}), spoken: true } }).where(eq(messages.id, reply.id));
      }
    }
  }
  return Response.json({ reply: reply.text, handoff, summary, upset, actions: reply.meta?.actions ?? [], conversationId: conversation.id, ...(voice ? { voice } : {}) });
}

/** Менеджер писал клиенту за последние ms (и разговор после этого не возвращали агенту). */
async function operatorWroteWithin(conversationId: string, ms: number) {
  const [last] = await db
    .select({ role: messages.role, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), sql`(${messages.role} = 'operator' or (${messages.role} = 'system' and ${messages.text} = 'returned'))`))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return Boolean(last && last.role === "operator" && Date.now() - last.createdAt.getTime() < ms);
}
