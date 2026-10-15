import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { type ApiConfig,
  agents,
  channels,
  clients,
  conversations,
  messages,
  type Channel,
  type Conversation,
  type MessageMeta,
  type InstagramConfig,
  type TelegramConfig,
  type ThreadsConfig,
  type EmailConfig,
  type ClientMemory,
} from "@/db/schema";
import * as ig from "@/lib/channels/meta/instagram";
import * as th from "@/lib/channels/meta/threads";
import { agentConfigSchema } from "@/lib/agent/types";
import { unverifiedFacts } from "@/lib/agent/factcheck";
import { extractHandoff, prepareChat } from "@/lib/agent/runtime";
import { handoffSummary } from "@/lib/agent/summary";
import { streamChat, MissingKeyError, type ChatMessage } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { agentMonthSpend, logUsage } from "@/lib/usage";
import { ordersNote } from "@/lib/agent/orders";
import { memoryNote } from "@/lib/agent/memory";
import { handoffEtaNote, measuredReplyMinutes } from "@/lib/agent/eta";
import { sendChatAction, sendText, replyInGroup } from "@/lib/channels/telegram-api";
import { sendEmailReply } from "@/lib/channels/email-send";

const HISTORY_LIMIT = 40;
/** Пауза перед ответом: клиент часто пишет несколькими сообщениями подряд. */
const REPLY_DEBOUNCE_MS = 1200;

// Состояние процесса: таймеры ответа, блокировки генерации, «агент печатает».
const g = globalThis as unknown as {
  __convTimers?: Map<string, ReturnType<typeof setTimeout>>;
  __convBusy?: Set<string>;
  __convAgain?: Set<string>;
};
const timers = (g.__convTimers ??= new Map());
const busy = (g.__convBusy ??= new Set());
const again = (g.__convAgain ??= new Set());

export function isTyping(conversationId: string) {
  return busy.has(conversationId) || timers.has(conversationId);
}

export async function upsertConversation(
  channel: Pick<Channel, "id" | "agentId" | "clientId" | "type">,
  externalId: string,
  contact: { name?: string; handle?: string } = {},
): Promise<{ conversation: Conversation; created: boolean }> {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.channelId, channel.id), eq(conversations.externalId, externalId)));
  if (existing) {
    if ((contact.name && contact.name !== existing.contactName) || (contact.handle && contact.handle !== existing.contactHandle)) {
      await db
        .update(conversations)
        .set({ contactName: contact.name ?? existing.contactName, contactHandle: contact.handle ?? existing.contactHandle })
        .where(eq(conversations.id, existing.id));
    }
    return { conversation: existing, created: false };
  }
  const [created] = await db
    .insert(conversations)
    .values({
      clientId: channel.clientId,
      agentId: channel.agentId,
      channelId: channel.id,
      channelType: channel.type,
      externalId,
      contactName: contact.name ?? "",
      contactHandle: contact.handle ?? "",
    })
    .returning();
  return { conversation: created, created: true };
}

export async function addMessage(
  conversationId: string,
  role: "user" | "assistant" | "operator" | "system",
  text: string,
  extra: { authorId?: string; meta?: MessageMeta; status?: "sent" | "draft" | "rejected"; externalId?: string; botId?: string } = {},
) {
  const [m] = await db
    .insert(messages)
    .values({
      conversationId,
      role,
      text,
      authorId: extra.authorId,
      meta: extra.meta,
      status: extra.status ?? "sent",
      externalId: extra.externalId,
      botId: extra.botId,
    })
    .onConflictDoNothing()
    .returning();
  // Это сообщение бот уже прислал журналом переписки (тот же номер) — оно есть, второй раз не пишем
  if (!m && extra.botId) {
    const [same] = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.botId, extra.botId)));
    return same;
  }
  if (role !== "system" && extra.status !== "draft") {
    await db
      .update(conversations)
      .set({
        lastMessageText: text.slice(0, 200),
        lastMessageAt: new Date(),
        ...(role === "user"
          ? {
              unread: sql`${conversations.unread} + 1`,
              status: "open" as const,
              // В режиме менеджера каждое сообщение клиента требует внимания.
              needsAttention: sql`CASE WHEN ${conversations.mode} = 'human' THEN 1 ELSE ${conversations.needsAttention} END`,
            }
          : {}),
      })
      .where(eq(conversations.id, conversationId));
  }
  return m;
}

/** Запланировать ответ агента (с небольшой паузой, чтобы собрать несколько сообщений подряд). */
export function scheduleReply(conversationId: string) {
  const prev = timers.get(conversationId);
  if (prev) clearTimeout(prev);
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      void respond(conversationId);
    }, REPLY_DEBOUNCE_MS),
  );
}

/** Сгенерировать и отправить ответ агента. Одновременно — не больше одной генерации на диалог. */
export async function respond(conversationId: string): Promise<void> {
  if (busy.has(conversationId)) {
    again.add(conversationId);
    return;
  }
  busy.add(conversationId);
  try {
    const [row] = await db
      .select({ conversation: conversations, agent: agents, client: clients, channel: channels })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(eq(conversations.id, conversationId));
    if (!row) return;
    const { conversation, agent, client, channel } = row;

    if (conversation.mode === "human") {
      // Разговор ведёт сотрудник — сообщаем ему в Telegram, что клиент написал (с кнопкой «Ответить»).
      const [last] = await db
        .select({ id: messages.id, role: messages.role, text: messages.text })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt), desc(sql`rowid`))
        .limit(1);
      if (last?.role === "user") void notify().then((n) => n.notifyClientMessage(conversationId, last.text, last.id));
      return;
    }
    if (!channel.enabled) return;
    if (agent.status !== "active") {
      await flag(conversationId, "agent_not_active");
      return;
    }

    const history = await db
      .select({ role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent")))
      // rowid — порядок вставки, на случай одинакового времени
      .orderBy(desc(messages.createdAt), desc(sql`rowid`))
      .limit(HISTORY_LIMIT);
    const pendingDraft = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "draft")))
      .limit(1);
    if (pendingDraft.length) {
      // Черновик ждёт решения менеджера. Если одобрение с тех пор выключили — он устарел: снимаем и отвечаем сами.
      if (needsApproval(channel, conversation)) return;
      await db.update(messages).set({ status: "rejected" }).where(and(eq(messages.conversationId, conversationId), eq(messages.status, "draft")));
    }
    const chat = historyForAi(history.reverse());
    if (chat.at(-1)?.role !== "user") return; // уже ответили

    const config = agentConfigSchema.parse(agent.config);
    // Месячный лимит расходов агента: превышен — молчим и зовём менеджера.
    if (config.monthlyBudgetUsd != null && (await agentMonthSpend(agent.id)) >= config.monthlyBudgetUsd) {
      await flag(conversationId, "budget_exceeded");
      return;
    }
    const { system, messages: prepared, kb, tools } = await prepareChat(
      config,
      client,
      chat,
      { mode: "live", agentId: agent.id, conversationId },
      withMemory(
        config.memory && conversation.kind === "dm" ? conversation.context?.memory : undefined,
        channel.type === "email"
        ? emailNote(client.name, conversation.contactName)
        : conversation.kind === "comment"
          ? commentNote(channel.type === "api" ? "telegram" : channel.type, conversation.context?.postText)
          : channel.type === "api"
            ? apiNote(conversation.context?.language, conversation.context?.botContext, (channel.config as ApiConfig).botNote, botActivity(history), ordersNote(conversation.context?.orders), handoffEtaNote(conversation.context?.team, await measuredReplyMinutes(channel.id)))
            : undefined,
      ),
    );

    if (channel.type === "telegram" && conversation.kind !== "comment") {
      void sendChatAction((channel.config as TelegramConfig).token, conversation.externalId);
    }

    const started = Date.now();
    let text = "";
    let meta: MessageMeta = {};
    const used: { name: string; error?: boolean }[] = [];
    const toolResults: string[] = [];
    let booked = false;
    for await (const ev of streamChat({ model: config.model, effort: config.effort, system, messages: prepared, tools })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "tool") {
        used.push({ name: ev.name, ...(ev.error ? { error: true } : {}) });
        toolResults.push(ev.result);
        if (ev.name === "book_appointment" && !ev.error && ev.result.startsWith("Booked:")) booked = true;
      } else {
        const ms = Date.now() - started;
        const cost = await logUsage({
          source: "channel",
          model: findModel(ev.servedBy) ? ev.servedBy : config.model,
          usage: ev.usage,
          agentId: agent.id,
          clientId: client.id,
          conversationId,
          ms,
        });
        meta = {
          model: ev.servedBy,
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
          cost: cost ?? undefined,
          ms,
          kb: kb ? { mode: kb.mode, sources: kb.sources.map((s) => s.title) } : null,
          ...(used.length ? { tools: used } : {}),
        };
        if (ev.stopReason === "refusal" && !text.trim()) throw new Error("refusal");
      }
    }

    // Запись уже создана в календаре — отмечаем это в переписке, что бы ни было дальше с ответом.
    if (booked) await addMessage(conversationId, "system", "booking_created");

    const { text: clean, handoff, actions } = extractHandoff(text);
    if (actions.length) meta = { ...meta, actions };
    // Комментарий, на который не нужно отвечать (реакция, эмодзи, разговор людей между собой), — молчим.
    if (conversation.kind === "comment" && SKIP_RE.test(clean.trim())) {
      await addMessage(conversationId, "system", "comment_skipped", { meta });
      return;
    }
    const reply = toPlainText(clean);
    // Проверка на выдуманные факты: цены, суммы, телефоны, ссылки, которых нет ни в указаниях с базой знаний,
    // ни в переписке, ни в результатах инструментов. Помечаем; в строгом режиме агента — не отправляем.
    const unverified = reply
      ? unverifiedFacts(reply, [typeof system === "string" ? system : JSON.stringify(system), JSON.stringify(prepared), ...toolResults].join("\n"))
      : [];
    if (unverified.length) meta = { ...meta, unverified };
    const blocked = unverified.length > 0 && config.factGuard === "block";
    if (blocked && channel.type === "api" && conversation.kind !== "comment") {
      // Свой бот ждёт ответ сразу: ответа нет — бот поступает как без агента (передаёт клиента менеджеру).
      await addMessage(conversationId, "assistant", reply, { meta: { ...meta, handoff }, status: "rejected" });
      await addMessage(conversationId, "system", "fact_blocked", { meta: { unverified } });
      await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, conversationId));
      void notify().then((n) =>
        n.notifyHandoff(
          conversationId,
          `Агент хотел ответить с данными, которых нет в базе знаний (${unverified.join(", ")}), — ответ не отправлен, бот передал клиента менеджеру.\n\nОтвет агента: ${reply.slice(0, 600)}`,
        ),
      );
      return;
    }
    // Публичные ответы (комментарии, Threads) по настройке канала сначала идут на одобрение.
    // Публичные ответы и письма по настройке канала сначала идут на одобрение.
    const approval = needsApproval(channel, conversation) || blocked;
    if (reply && approval) {
      const draft = await addMessage(conversationId, "assistant", reply, { meta: { ...meta, handoff }, status: "draft" });
      void notify().then((n) => n.notifyDraft(draft.id));
      await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, conversationId));
    } else if (reply) {
      const externalId = await deliver(channel, conversation, reply);
      await addMessage(conversationId, "assistant", reply, { meta: { ...meta, handoff }, externalId: externalId ?? undefined });
    }
    if (handoff) {
      // Свой бот сам передаёт клиента менеджеру (по флагу handoff) и сам решает, когда агенту снова отвечать.
      await db
        .update(conversations)
        .set(channel.type === "api" ? { needsAttention: true } : { mode: "human", needsAttention: true })
        .where(eq(conversations.id, conversationId));
      // Выжимка для менеджера: что клиент ищет и чего ждёт — чтобы не перечитывать всю переписку.
      const summary = await handoffSummary(conversationId, { agentId: agent.id, clientId: client.id });
      // Клиент недоволен (агент поставил [[ACTION mood: upset]]) — уведомление с пометкой «срочно».
      const upset = actions.some((a) => a.type === "mood" && /upset|angry/i.test(a.value));
      await addMessage(conversationId, "system", "handoff", summary || upset ? { meta: { ...(summary ? { summary } : {}), ...(upset ? { upset } : {}) } } : {});
      void notify().then((n) => n.notifyHandoff(conversationId, summary, { upset }));
    }
  } catch (e) {
    console.error("respond failed", conversationId, e);
    const code = e instanceof MissingKeyError ? `missing_key:${e.envName}` : e instanceof Error ? e.message : String(e);
    await flag(conversationId, code).catch(() => {});
  } finally {
    busy.delete(conversationId);
    if (again.delete(conversationId)) void respond(conversationId);
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  ru: "русский",
  uk: "українська",
  en: "English",
  es: "español",
  de: "Deutsch",
  fr: "français",
  it: "italiano",
  pl: "polski",
};

/** Переписка для ИИ (от старых к новым): без служебных строк и текстов самого бота (меню, шаблоны — не реплики агента). */
export function historyForAi(history: { role: string; text: string; meta?: MessageMeta | null }[]): ChatMessage[] {
  return history
    .filter((m) => m.role !== "system" && m.role !== "bot")
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: withVision(m) }));
}

/** Сообщение клиента для ИИ: к фото — описание того, что на нём (агент сам фото не видит). */
function withVision(m: { role: string; text: string; meta?: MessageMeta | null }) {
  // Вложение без подписи из журнала (фото, видео…) — ИИ не принимает пустые сообщения
  if (!m.meta?.vision) return m.text.trim() ? m.text : `[${m.role === "user" ? "Клиент прислал" : "Отправлено клиенту"}: ${m.meta?.kind ?? "вложение"}]`;
  return `${m.text ? `${m.text}\n\n` : ""}[Клиент прислал фото. На фото: ${m.meta.vision}]`;
}

const ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;
const ACTIVITY_LINES = 12;

/**
 * Что клиент делал в боте после последнего ответа агента (из журнала переписки своего бота): что бот показал
 * (меню, карточки, уведомления о заявке), какие кнопки клиент нажимал, реакции, ответы людей в самом боте.
 * Без ИИ: последние строки за 2 часа, коротко. history — от новых к старым (как из базы) или от старых к новым.
 */
export function botActivity(history: { role: string; text: string; meta?: MessageMeta | null; createdAt?: Date }[]) {
  const ordered = [...history].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  // С последнего ответа агента; последнее сообщение клиента (на которое отвечаем) — не «действие», оно в переписке
  let from = 0;
  ordered.forEach((m, i) => {
    if (m.role === "assistant") from = i + 1;
  });
  const now = Date.now();
  const lines: string[] = [];
  for (const m of ordered.slice(from)) {
    if (m.createdAt && now - m.createdAt.getTime() > ACTIVITY_WINDOW_MS) continue;
    const text = m.text.replace(/\s+/g, " ").trim().slice(0, 160);
    const kind = m.meta?.kind;
    if (m.role === "bot") lines.push(`Бот показал: ${text || `[${kind ?? "вложение"}]`}`);
    else if (m.role === "operator") lines.push(`Сотрудник ответил клиенту в боте: ${text}`);
    else if (m.role === "user" && kind === "button") lines.push(`Клиент нажал кнопку «${text}»`);
    else if (m.role === "user" && kind === "reaction") lines.push(`Клиент поставил реакцию ${text}`);
    else if (m.role === "user" && kind && kind !== "text" && kind !== "edit") lines.push(`Клиент прислал: ${kind}${text ? ` (${text})` : ""}`);
  }
  if (!lines.length) return undefined;
  return lines.slice(-ACTIVITY_LINES).join("\n");
}

/** Указания канала + что агент помнит о клиенте. */
function withMemory(memory: ClientMemory | undefined, note: string | undefined) {
  const parts = [note, memoryNote(memory)].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Свой бот: язык ответа задаёт бот (язык, выбранный клиентом в боте) — он важнее настройки агента. */
function apiNote(language?: string, botContext?: string, botNote?: string, activity?: string, orders?: string, eta?: string) {
  const parts: string[] = [];
  if (language) {
    const name = LANGUAGE_NAMES[language] ?? language;
    parts.push(
      `# Язык ответа\nКлиент пользуется ботом на языке: ${name}. Отвечай только на этом языке — даже если клиент написал на другом. Это правило важнее любых других указаний о языке.`,
    );
  }
  parts.push(
    `# Канал: Telegram-бот компании\nТы отвечаешь внутри Telegram-бота компании (в чате или в его мини-приложении). Пиши простым текстом без markdown. Клиент может присылать в чат фото и голосовые — бот их принимает: голосовое придёт тебе текстом, а к фото ты получишь описание того, что на нём. Не говори, что фото или голосовые отправить нельзя.${botNote?.trim() ? `\nЧто есть в боте — можно советовать этим воспользоваться: ${botNote.trim()}` : ""}`,
  );
  // Кнопки под ответом: разделы бота (коды из «Что есть в боте») и подсказки следующего вопроса.
  parts.push(
    [
      "# Кнопки под ответом",
      "Можешь добавить в самом конце ответа служебные строки — клиент их не увидит, бот покажет кнопки:",
      "• до 3 строк [[ACTION suggest: <следующий вопрос клиента от первого лица, до 40 символов>]] — естественные продолжения разговора (например: «Скільки це коштує?», «Як замовити?»);",
      "• если в «Что есть в боте» у кнопок указаны коды — до 2 строк [[ACTION button: <код>]] с самыми полезными сейчас разделами; тогда не объясняй подробно, где искать кнопку в меню.",
      "Не добавляй кнопки на приветствие, благодарность или когда передаёшь менеджеру.",
    ].join("\n"),
  );
  if (botContext) parts.push(`# Что клиент сейчас открыл в боте\n${botContext}`);
  if (orders) parts.push(orders);
  if (eta) parts.push(eta);
  if (activity) {
    parts.push(
      `# Что клиент делал в боте после твоего последнего ответа\nУчитывай это, не переспрашивай то, что уже видно отсюда, и не повторяй то, что бот уже показал:\n${activity}`,
    );
  }
  return parts.join("\n\n");
}

/** Ответ сначала на одобрение? Комментарии публичные: без явного «выключить» — да. Почта — по настройке. */
function needsApproval(channel: Pick<Channel, "type" | "config">, conversation: Pick<Conversation, "kind">) {
  const setting = (channel.config as { approval?: boolean }).approval;
  return conversation.kind === "comment" ? (setting ?? true) : channel.type === "email" && Boolean(setting);
}

const SKIP_RE = /^\[?SKIP\]?\.?$/i;
const PLATFORMS: Record<string, string> = { telegram: "Telegram-канале", instagram: "Instagram", threads: "Threads" };

/** Публичный комментарий под постом: ответ видят все, пост — тема разговора. */
function commentNote(type: string, postText?: string) {
  return [
    `# Канал: комментарии под постом в ${PLATFORMS[type] ?? type}`,
    "Ты отвечаешь публично в комментариях — ответ увидят все подписчики. 1–2 коротких предложения, простым текстом без markdown. Личные данные и детали заказа — только в личных сообщениях.",
    postText ? `Пост, под которым оставлен комментарий:\n«${postText}»` : "",
    "Если комментарий не требует ответа (только эмодзи или реакция, благодарность без вопроса, спам, разговор людей между собой, оскорбления) — ответь ровно одним словом: SKIP.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Письмо — не мессенджер: другой формат ответа. */
function emailNote(company: string, contactName: string) {
  return [
    "# Канал: электронная почта",
    "Сейчас ты отвечаешь на письмо, а не в мессенджере. Правило «1–4 предложения» здесь не действует: пиши как короткое деловое письмо.",
    `Начни с приветствия${contactName ? ` по имени (${contactName})` : ""}, затем 1–3 коротких абзаца по делу, без markdown и списков со звёздочками.`,
    `В конце — подпись отдельной строкой на том же языке, что и всё письмо: по-русски «С уважением, команда ${company}», по-украински «З повагою, команда ${company}», по-английски «Best regards, ${company} team».`,
    "Пиши каждое слово целиком на одном алфавите — не смешивай кириллицу и латиницу внутри слова.",
    "Тему письма не пиши — она подставится сама.",
  ].join("\n");
}

/** Ошибка или ситуация, где нужен человек: служебное сообщение + отметка «требует внимания». */
async function flag(conversationId: string, code: string) {
  await addMessage(conversationId, "system", code, { meta: { error: code } });
  const [c] = await db
    .update(conversations)
    .set({ needsAttention: true })
    .where(eq(conversations.id, conversationId))
    .returning({ agentId: conversations.agentId });
  // Одна и та же проблема агента — одно уведомление в сутки, а не на каждый диалог.
  void notify().then((n) => n.notifyProblem(`agent:${c?.agentId}:${code.split(":")[0]}`, code, { conversationId }));
}

/** Уведомления студии в Telegram (подключаются лениво — модуль сам зависит от диалогов). */
const notify = () => import("@/lib/notify/telegram");

/**
 * Доставить сообщение клиенту в его канал; возвращает id сообщения в соцсети (если есть).
 * Виджет забирает сообщения сам (опросом).
 */
export async function deliver(
  channel: Pick<Channel, "type" | "config">,
  conversation: Pick<Conversation, "externalId" | "kind" | "context">,
  text: string,
): Promise<string | null> {
  switch (channel.type) {
    case "telegram": {
      const token = (channel.config as TelegramConfig).token;
      if (conversation.kind === "comment") {
        return replyInGroup(token, conversation.context?.chatId ?? "", conversation.context?.replyToId ?? "", text);
      }
      await sendText(token, conversation.externalId, text);
      return null;
    }
    case "instagram": {
      const cfg = channel.config as InstagramConfig;
      if (conversation.kind === "comment") {
        return ig.replyToComment(cfg.token, conversation.context?.replyToId ?? "", text);
      }
      return ig.sendDm(cfg.token, conversation.externalId.replace(/^dm:/, ""), text);
    }
    case "threads": {
      const cfg = channel.config as ThreadsConfig;
      return th.publishReply(cfg.token, conversation.context?.replyToId ?? "", text);
    }
    case "email":
      return sendEmailReply(channel.config as EmailConfig, conversation, text);
    default:
      return null;
  }
}

/** Мессенджеры показывают markdown звёздочками — убираем разметку. */
export function toPlainText(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export async function listMessages(conversationId: string, opts: { afterId?: string } = {}) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(sql`rowid`));
  if (!opts.afterId) return rows;
  const i = rows.findIndex((m) => m.id === opts.afterId);
  return i < 0 ? rows : rows.slice(i + 1);
}
