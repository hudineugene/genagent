import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvals, channels, clients, conversations, knowledgeGaps, messages, settings, type Approval } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { callTelegram, TelegramError } from "@/lib/channels/telegram-api";
import { approveDraftCore, rejectDraftCore } from "@/lib/drafts";
import { canReply, operatorReplyCore, returnToAgentCore } from "@/lib/operator";
import { addAnswerToKb } from "@/lib/agent/kb-answers";
import { isSticker } from "@/lib/sticker";
import type { LeadCard } from "@/db/schema";

/**
 * Уведомления студии в Telegram — отдельный бот (его создают в @BotFather).
 * Сотрудник подписывается ссылкой t.me/<бот>?start=<код> из «Интеграций», отписывается командой /stop.
 * Что приходит: клиент передан менеджеру (с выжимкой), черновик ждёт одобрения (с кнопками), сбои каналов и агентов.
 */
export type NotifySubscriber = { chatId: string; name: string; since: number };
/** Владелец бизнеса клиента: получает только вопросы своего агента без ответа и отвечает на них (в базу знаний). */
export type NotifyOwner = NotifySubscriber & { clientId: string };
export type NotifySettings = {
  token: string;
  botUsername: string;
  /** Секрет ссылки подписки: без него подписаться нельзя */
  linkCode: string;
  /** Адрес админки для ссылок «Открыть диалог» (Tailscale) */
  adminUrl: string;
  subscribers: NotifySubscriber[];
  /** Владельцы клиентов — отдельно от сотрудников студии: общие рассылки им не уходят */
  owners?: NotifyOwner[];
  /** Секрет ссылки владельца для каждого клиента (t.me/<бот>?start=c_<код>) */
  clientCodes?: Record<string, string>;
};

const KEY = "notify";
const PROBLEM_PAUSE_MS = 24 * 60 * 60 * 1000;

export async function getNotifySettings() {
  return getSetting<NotifySettings>(KEY);
}

/** null — отключить уведомления (настройки удаляются). */
export async function saveNotifySettings(s: NotifySettings | null) {
  if (s) await setSetting(KEY, s);
  else await db.delete(settings).where(eq(settings.key, KEY));
  startNotifyPolling();
}

export const newLinkCode = () => randomBytes(9).toString("base64url");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(s: NotifySettings, chatId: string, html: string, markup?: unknown) {
  return callTelegram<{ message_id: number }>(s.token, "sendMessage", {
    chat_id: chatId,
    text: html.slice(0, 4000),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(markup ? { reply_markup: markup } : {}),
  });
}

/** Разослать всем подписчикам; сбой у одного не мешает остальным. */
async function broadcast(html: string, markup?: unknown) {
  const s = await getNotifySettings();
  if (!s?.token || !s.subscribers.length) return;
  await Promise.all(
    s.subscribers.map((sub) =>
      send(s, sub.chatId, html, markup).catch((e) => {
        console.error("notify send failed", sub.chatId, e instanceof Error ? e.message : e);
      }),
    ),
  );
}

async function conversationInfo(conversationId: string) {
  const [row] = await db
    .select({ conversation: conversations, agent: agents, client: clients, channel: channels })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  return row;
}

const CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  widget: "сайт",
  instagram: "Instagram",
  threads: "Threads",
  email: "почта",
  api: "свой бот",
  whatsapp: "WhatsApp",
};

function header(row: NonNullable<Awaited<ReturnType<typeof conversationInfo>>>) {
  const c = row.conversation;
  const who = c.contactName || c.contactHandle || "клиент";
  return `<b>${esc(row.client.name)}</b> · ${esc(CHANNEL_LABEL[row.channel.type] ?? row.channel.type)} · ${esc(who)}`;
}

function openLink(s: NotifySettings | undefined, conversationId: string) {
  if (!s?.adminUrl) return undefined;
  return { inline_keyboard: [[{ text: "Открыть диалог", url: `${s.adminUrl}/inbox?c=${conversationId}` }]] };
}

/**
 * Кнопки под уведомлением о клиенте: «Ответить» (ответ пишется прямо сюда и уходит клиенту), «Вернуть агенту»
 * и «Открыть диалог». Свой бот без очереди ответов — отвечает его менеджер в самом боте, только ссылка.
 */
function conversationButtons(s: NotifySettings | undefined, row: NonNullable<Awaited<ReturnType<typeof conversationInfo>>>) {
  const id = row.conversation.id;
  const rows: { text: string; callback_data?: string; url?: string }[][] = [];
  if (canReply(row.channel, row.conversation.kind)) {
    rows.push([
      { text: "✍️ Ответить", callback_data: `rp:${id}` },
      { text: "🤖 Вернуть агенту", callback_data: `rt:${id}` },
    ]);
  }
  rows.push([{ text: "📋 Бриф перед звонком", callback_data: `br:${id}` }]);
  if (s?.adminUrl) rows.push([{ text: "Открыть диалог", url: `${s.adminUrl}/inbox?c=${id}` }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** Отметка под обработанным уведомлением (кнопки убираем). */
async function markDone(s: NotifySettings, q: { message?: { chat: { id: number | string }; message_id: number; text?: string } }, mark: string) {
  if (!q.message) return;
  await callTelegram(s.token, "editMessageText", {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    text: `${(q.message.text ?? "").slice(0, 3500)}\n\n${mark}`,
    link_preview_options: { is_disabled: true },
  }).catch(() => {});
}

/**
 * Уведомление о разговоре — ответственным по распределению заявок (если у клиента есть правила), иначе всем.
 * assignText — по чему выбрать тему, если ответственные ещё не назначены (причина и выжимка передачи).
 */
async function sendRouted(row: NonNullable<Awaited<ReturnType<typeof conversationInfo>>>, html: string, markup?: unknown, assignText?: string) {
  const s = await getNotifySettings();
  if (!s?.token) return;
  let target = row.conversation.context?.assignedTo ?? null;
  if (!target && assignText) {
    const { assignConversation } = await import("@/lib/routing");
    target = await assignConversation(row.conversation.id, row.client.id, assignText);
  }
  if (!target?.chatIds.length) return broadcast(html, markup);
  let sent = 0;
  for (const chatId of target.chatIds) {
    try {
      await send(s, chatId, `${html}\n\n👤 <i>${esc(target.rule)}</i>`, markup);
      sent++;
    } catch (e) {
      console.error("routed notify failed", chatId, e instanceof Error ? e.message : e);
    }
  }
  // Ответственные отписались от бота — чтобы клиент не потерялся, уведомляем всех
  if (!sent) await broadcast(html, markup);
}

/** Агент передал клиента менеджеру. */
export async function notifyHandoff(conversationId: string, summary: string | null, opts: { upset?: boolean; draft?: string | null; reason?: string; lead?: LeadCard | null } = {}) {
  try {
    const row = await conversationInfo(conversationId);
    if (!row) return;
    const s = await getNotifySettings();
    const reply = canReply(row.channel, row.conversation.kind);
    const note = reply
      ? "\n<i>Ответить клиенту можно прямо отсюда — кнопка «Ответить».</i>"
      : row.channel.type === "api"
        ? "\n<i>Заявка создана в боте клиента — отвечает его менеджер.</i>"
        : "";
    const title = opts.upset
      ? "🔴 <b>Срочно: клиент недоволен — нужен человек</b>"
      : "🙋 <b>Клиент передан менеджеру</b>";
    const draft = reply && opts.draft ? `\n\n💡 <b>Черновик ответа:</b>\n<i>${esc(opts.draft)}</i>` : "";
    const buttons = conversationButtons(s, row);
    if (draft && buttons) buttons.inline_keyboard.unshift([{ text: "📤 Отправить черновик", callback_data: `sd:${row.conversation.id}` }]);
    const why = opts.reason ? `<b>Причина:</b> ${esc(opts.reason)}\n` : "";
    const lead = opts.lead ? `${leadHtml(opts.lead)}\n\n` : "";
    await sendRouted(row, `${title}\n${header(row)}\n\n${why}${lead}${summary ? esc(summary) : "<i>Выжимки нет — откройте диалог.</i>"}${draft}${note}`, buttons, [opts.reason, summary].filter(Boolean).join("\n"));
  } catch (e) {
    console.error("notify handoff failed", e);
  }
}

const LEAD_TEMP: Record<LeadCard["temperature"], string> = { hot: "🔥 Горячий", warm: "🌤 Тёплый", cold: "❄️ Холодный" };

/** Карточка лида для Telegram: «горячесть», почему и поля со слов клиента. */
export function leadHtml(lead: LeadCard) {
  return [
    `<b>${LEAD_TEMP[lead.temperature]}</b>${lead.reason ? ` — ${esc(lead.reason)}` : ""}`,
    ...lead.fields.map((f) => `${esc(f.label)}: <b>${esc(f.value)}</b>`),
  ].join("\n");
}

// Сообщения клиента, о которых уже сообщили (разговор у сотрудника) — по одному уведомлению на сообщение.
const told = new Map<string, string>();
// Когда сообщили о стикере клиента: серия стикеров подряд — одно уведомление
const stickerTold = new Map<string, number>();
const STICKER_QUIET_MS = 10 * 60 * 1000;

/** Клиент написал, пока разговор ведёт сотрудник: текст и кнопка «Ответить». */
export async function notifyClientMessage(conversationId: string, text: string, messageKey = text) {
  try {
    if (told.get(conversationId) === messageKey) return;
    told.set(conversationId, messageKey);
    if (isSticker(text)) {
      const at = stickerTold.get(conversationId);
      if (at && Date.now() - at < STICKER_QUIET_MS) return;
      stickerTold.set(conversationId, Date.now());
      if (stickerTold.size > 500) stickerTold.delete(stickerTold.keys().next().value as string);
    } else stickerTold.delete(conversationId);
    if (told.size > 500) told.delete(told.keys().next().value as string);
    const row = await conversationInfo(conversationId);
    if (!row) return;
    // Свой бот: сообщаем, только если разговор ведут отсюда (последний ответ сотрудника — из GenAgent или Telegram).
    // Если менеджер отвечает в самом боте клиента, он и так видит переписку там — не дублируем.
    if (row.channel.type === "api") {
      const [lastOp] = await db
        .select({ externalId: messages.externalId })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "operator")))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (!lastOp || lastOp.externalId === "bot") return;
    }
    const s = await getNotifySettings();
    await sendRouted(row, `💬 <b>Клиент пишет</b>\n${header(row)}\n\n${esc(text.slice(0, 1500))}`, conversationButtons(s, row));
  } catch (e) {
    console.error("notify client message failed", e);
  }
}

/** Горячий клиент сейчас в чате (карточка лида), а менеджеру его ещё не передавали. */
export async function notifyHotLead(conversationId: string, lead: LeadCard) {
  try {
    const row = await conversationInfo(conversationId);
    if (!row) return;
    const s = await getNotifySettings();
    const [last] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const quote = last?.text ? `\n\n💬 <i>${esc(last.text.slice(0, 400))}</i>` : "";
    await sendRouted(
      row,
      `🔥 <b>Горячий клиент сейчас в чате</b>\n${header(row)}\n\n${leadHtml(lead)}${quote}\n\n<i>Агент ведёт разговор сам — подключитесь, если хотите закрыть сделку лично.</i>`,
      conversationButtons(s, row),
      [lead.reason, ...lead.fields.map((f) => `${f.label}: ${f.value}`), last?.text].filter(Boolean).join("\n"),
    );
  } catch (e) {
    console.error("notify hot lead failed", e);
  }
}

/** Клиент ждёт ответа человека дольше порога (lib/agent/waiting): повторное уведомление, urgent — 🔴. */
export async function notifyWaiting(conversationId: string, minutes: number, urgent: boolean, lastText: string) {
  try {
    const row = await conversationInfo(conversationId);
    if (!row) return;
    const s = await getNotifySettings();
    const wait = minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60 ? `${minutes % 60} мин` : ""}`.trim() : `${minutes} мин`;
    const title = urgent ? `🔴 <b>Клиент ждёт ответа уже ${wait}</b>` : `⏳ <b>Клиент ждёт ответа ${wait}</b>`;
    const quote = lastText ? `\n\n<i>${esc(lastText.slice(0, 600))}</i>` : "";
    await sendRouted(row, `${title}\n${header(row)}${quote}`, conversationButtons(s, row));
  } catch (e) {
    console.error("notify waiting failed", e);
  }
}

/** Черновик ответа ждёт одобрения: текст и кнопки «Опубликовать / Отклонить». */
export async function notifyDraft(messageId: string) {
  try {
    const [m] = await db.select().from(messages).where(eq(messages.id, messageId));
    if (!m) return;
    const row = await conversationInfo(m.conversationId);
    if (!row) return;
    const s = await getNotifySettings();
    // Сообщение клиента, на которое отвечает черновик.
    const [question] = await db
      .select({ text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, m.conversationId), eq(messages.role, "user")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const buttons = [
      [
        { text: "✅ Опубликовать", callback_data: `ap:${messageId}` },
        { text: "✖️ Отклонить", callback_data: `rj:${messageId}` },
      ],
      ...(s?.adminUrl ? [[{ text: "Изменить в студии", url: `${s.adminUrl}/inbox?c=${m.conversationId}` }]] : []),
    ];
    await broadcast(
      `📝 <b>Черновик ответа ждёт одобрения</b>\n${header(row)}${m.meta?.unverified?.length ? `\n⚠️ Нет в базе знаний: ${esc(m.meta.unverified.join(", "))} — проверьте перед публикацией` : ""}\n\n${question ? `💬 ${esc(question.text.slice(0, 600))}\n\n` : ""}🤖 ${esc(m.text.slice(0, 2500))}`,
      { inline_keyboard: buttons },
    );
  } catch (e) {
    console.error("notify draft failed", e);
  }
}

// Сбои — не чаще раза в сутки на одну и ту же проблему.
const g = globalThis as unknown as { __notifyProblems?: Map<string, number> };
const problems = (g.__notifyProblems ??= new Map());

const PROBLEM_TEXT: Record<string, string> = {
  agent_not_active: "агент выключен — сообщение клиента осталось без ответа",
  budget_exceeded: "исчерпан месячный лимит расходов агента — ответы идут менеджеру",
  client_limit: "исчерпан месячный лимит расходов клиента — ответы идут менеджеру",
  missing_key: "не задан API-ключ модели — агент не может отвечать",
  refusal: "модель отказалась отвечать",
  email_auth_failed: "почта: Google не принял пароль приложения",
  email_unreachable: "почта: нет связи с сервером",
  token_invalid: "доступ к соцсети истёк или отозван — подключите заново",
  deauthorized: "владелец аккаунта отключил приложение",
};

/** Сбой у агента (по диалогу) или канала. key — чтобы не повторять одно и то же. */
export async function notifyProblem(key: string, code: string, context: { conversationId?: string; channelId?: string }) {
  try {
    const last = problems.get(key) ?? 0;
    if (Date.now() - last < PROBLEM_PAUSE_MS) return;
    problems.set(key, Date.now());
    const s = await getNotifySettings();
    let where = "";
    if (context.conversationId) {
      const row = await conversationInfo(context.conversationId);
      if (row) where = `${header(row)} · ${esc(row.agent.name)}`;
    } else if (context.channelId) where = await channelWhere(context.channelId);
    const text = PROBLEM_TEXT[code.split(":")[0]] ?? `ошибка: ${code.slice(0, 200)}`;
    await broadcast(`⚠️ <b>Сбой</b>\n${where}\n\n${esc(text)}`, context.conversationId ? openLink(s, context.conversationId) : undefined);
  } catch (e) {
    console.error("notify problem failed", e);
  }
}

async function channelWhere(channelId: string) {
  const [row] = await db
    .select({ channel: channels, client: clients })
    .from(channels)
    .innerJoin(clients, eq(clients.id, channels.clientId))
    .where(eq(channels.id, channelId));
  return row ? `<b>${esc(row.client.name)}</b> · ${esc(CHANNEL_LABEL[row.channel.type] ?? row.channel.type)} ${esc(row.channel.name)}` : "";
}

/** Сбой канала прошёл — сообщить, чтобы не казалось, что он ещё висит; следующий сбой снова придёт сразу, без суточной паузы. */
export async function notifyRecovered(key: string, channelId: string, text: string) {
  try {
    problems.delete(key);
    await broadcast(`✅ <b>Снова работает</b>
${await channelWhere(channelId)}

${esc(text)}`);
  } catch (e) {
    console.error("notify recovered failed", e);
  }
}

/** Разбор переписок нашёл новые вопросы без ответа. */
export async function notifyGaps(agentId: string, count: number) {
  try {
    const [row] = await db
      .select({ agent: agents, client: clients })
      .from(agents)
      .innerJoin(clients, eq(clients.id, agents.clientId))
      .where(eq(agents.id, agentId));
    if (!row) return;
    const s = await getNotifySettings();
    await broadcast(
      `📚 <b>Вопросы без ответа</b>
<b>${esc(row.client.name)}</b> · ${esc(row.agent.name)}

Новых вопросов, на которые агенту не хватило информации: ${count}. Добавьте ответы — агент начнёт отвечать сам.`,
      s?.adminUrl ? { inline_keyboard: [[{ text: "Открыть список", url: `${s.adminUrl}/agents/${agentId}/gaps` }]] } : undefined,
    );
  } catch (e) {
    console.error("notify gaps failed", e);
  }
}

/** Сообщение подписанным владельцам бизнеса клиента. Возвращает, скольким отправлено. */
export async function sendToOwners(clientId: string, html: string): Promise<number> {
  const s = await getNotifySettings();
  if (!s?.token) return 0;
  let n = 0;
  for (const o of (s.owners ?? []).filter((x) => x.clientId === clientId)) {
    try {
      await send(s, o.chatId, html);
      n++;
    } catch (e) {
      console.error("send to owner failed", o.chatId, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/** Заявка сотрудника на согласование — руководителям с кнопками «Согласовать» / «Отказать». Возвращает, скольким ушло. */
export async function notifyApproval(a: Approval, approvers: "owners" | "team" | "both"): Promise<number> {
  const s = await getNotifySettings();
  if (!s?.token) return 0;
  const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, a.clientId));
  const html = [
    `🗂 <b>Заявка №${a.number} на согласование</b>${c ? ` · ${esc(c.name)}` : ""}`,
    a.requester ? `От: ${esc(a.requester)}` : "",
    "",
    `<b>${esc(a.subject)}</b>`,
    a.details ? esc(a.details.slice(0, 2500)) : "",
    a.amount ? `💶 ${esc(a.amount)}` : "",
  ]
    .filter((x, i) => x || i === 2)
    .join("\n");
  const markup = { inline_keyboard: [[{ text: "✅ Согласовать", callback_data: `ap:${a.id}` }, { text: "❌ Отказать", callback_data: `ax:${a.id}` }]] };
  const chats = [
    ...(approvers !== "team" ? (s.owners ?? []).filter((o) => o.clientId === a.clientId).map((o) => o.chatId) : []),
    ...(approvers !== "owners" ? s.subscribers.map((x) => x.chatId) : []),
  ];
  let n = 0;
  for (const chatId of [...new Set(chats)]) {
    try {
      await send(s, chatId, html, markup);
      n++;
    } catch (e) {
      console.error("approval send failed", chatId, e instanceof Error ? e.message : e);
    }
  }
  return n;
}

/** Клиент оплатил по ссылке агента (или оплата отклонена / возвращена) — команде и владельцам бизнеса. */
export async function notifyPayment(p: { clientId: string; conversationId: string | null; amount: number; currency: string; description: string; status: string }) {
  try {
    const s = await getNotifySettings();
    const row = p.conversationId ? await conversationInfo(p.conversationId) : null;
    const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, p.clientId));
    const icon = p.status === "paid" ? "💳 <b>Оплата получена</b>" : p.status === "refunded" ? "↩️ <b>Возврат оплаты</b>" : "⚠️ <b>Оплата не прошла</b>";
    const html = `${icon}: <b>${p.amount} ${esc(p.currency)}</b>\n${row ? `${header(row)} · ${esc(row.agent.name)}` : c ? `<b>${esc(c.name)}</b>` : ""}\n${esc(p.description)}`;
    await broadcast(html, p.conversationId ? openLink(s, p.conversationId) : undefined);
    if (p.status === "paid") await sendToOwners(p.clientId, html);
  } catch (e) {
    console.error("notify payment failed", e);
  }
}

/** Сообщение сотрудникам студии (подписчикам бота уведомлений). */
export async function sendToTeam(html: string) {
  await broadcast(html);
}

/** Клиент прислал документ, данные из него извлечены — менеджеру. */
export async function notifyDocument(
  conversationId: string | null,
  clientId: string,
  doc: { type: string; filename: string; fields: Record<string, string>; summary: string },
) {
  try {
    const s = await getNotifySettings();
    const row = conversationId ? await conversationInfo(conversationId) : null;
    let where = row ? `${header(row)} · ${esc(row.agent.name)}` : "";
    if (!row) {
      const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
      where = c ? `<b>${esc(c.name)}</b>` : "";
    }
    const lines = Object.entries(doc.fields).map(([k, v]) => `• ${esc(k)}: ${esc(v.slice(0, 300))}`);
    await broadcast(
      `📄 <b>${esc(doc.type)}</b> · ${esc(doc.filename)}\n${where}\n\n${doc.summary ? `${esc(doc.summary)}\n\n` : ""}${lines.join("\n")}`,
      conversationId ? openLink(s, conversationId) : undefined,
    );
  } catch (e) {
    console.error("notify document failed", e);
  }
}

/** Клиент заполнил анкету или прошёл тест — ответы менеджеру. */
export async function notifyForm(
  conversationId: string | null,
  clientId: string,
  form: { name: string; answers: Record<string, string>; score: number | null; maxScore: number | null },
) {
  try {
    const s = await getNotifySettings();
    const row = conversationId ? await conversationInfo(conversationId) : null;
    let where = row ? `${header(row)} · ${esc(row.agent.name)}` : "";
    if (!row) {
      const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
      where = c ? `<b>${esc(c.name)}</b>` : "";
    }
    const lines = Object.entries(form.answers).map(([k, v]) => `• ${esc(k)}: ${esc(v.slice(0, 300))}`);
    const score = form.score != null ? `\n🎯 Баллы: <b>${form.score}</b> из ${form.maxScore}` : "";
    await broadcast(`📝 <b>Анкета «${esc(form.name)}»</b>\n${where}\n\n${lines.join("\n")}${score}`, conversationId ? openLink(s, conversationId) : undefined);
  } catch (e) {
    console.error("notify form failed", e);
  }
}

/** Сверка нашла, что один и тот же факт в данных агента записан по-разному (например, две цены объекта). */
export async function notifyConflicts(agentId: string, conflicts: { item: string; values: string[]; where: string }[]) {
  try {
    const [row] = await db
      .select({ agent: agents, client: clients })
      .from(agents)
      .innerJoin(clients, eq(clients.id, agents.clientId))
      .where(eq(agents.id, agentId));
    if (!row) return;
    const s = await getNotifySettings();
    const list = conflicts
      .map((c) => `• <b>${esc(c.item)}</b>: ${c.values.map((v) => esc(v)).join(" ↔ ")}${c.where ? `\n  <i>${esc(c.where)}</i>` : ""}`)
      .join("\n");
    await broadcast(
      `🔀 <b>Расхождение в данных агента</b>\n<b>${esc(row.client.name)}</b> · ${esc(row.agent.name)}\n\nОдно и то же записано по-разному — агент может назвать клиенту любое из значений. Исправьте устаревшее:\n${list}`,
      s?.adminUrl ? { inline_keyboard: [[{ text: "Открыть агента", url: `${s.adminUrl}/agents/${agentId}` }]] } : undefined,
    );
  } catch (e) {
    console.error("notify conflicts failed", e);
  }
}

/** Менеджер ответил клиенту так, что ответ пригодится и другим: предложить добавить его в базу знаний. */
export async function notifyLearned(gapId: string) {
  try {
    const [row] = await db
      .select({ gap: knowledgeGaps, agent: agents, client: clients })
      .from(knowledgeGaps)
      .innerJoin(agents, eq(agents.id, knowledgeGaps.agentId))
      .innerJoin(clients, eq(clients.id, knowledgeGaps.clientId))
      .where(eq(knowledgeGaps.id, gapId));
    if (!row?.gap.suggestion) return;
    const s = await getNotifySettings();
    const rows: { text: string; callback_data?: string; url?: string }[][] = [
      [
        { text: "✅ В базу знаний", callback_data: `kb:${gapId}` },
        { text: "Не нужно", callback_data: `kx:${gapId}` },
      ],
    ];
    if (s?.adminUrl) rows.push([{ text: "✏️ Изменить", url: `${s.adminUrl}/agents/${row.agent.id}/gaps` }]);
    await broadcast(
      `📚 <b>Добавить в базу знаний?</b>
<b>${esc(row.client.name)}</b> · ${esc(row.agent.name)}
Менеджер ответил клиенту — агент может отвечать так сам.

<b>Вопрос:</b> ${esc(row.gap.question)}
<b>Ответ:</b> ${esc(row.gap.suggestion)}`,
      { inline_keyboard: rows },
    );
  } catch (e) {
    console.error("notify learned failed", e);
  }
}

/** Отчёт еженедельной проверки агентов (автотесты). */
export async function notifyTestsReport(html: string, url?: string) {
  try {
    await broadcast(html, url ? { inline_keyboard: [[{ text: url.includes("/analytics") ? "Открыть аналитику" : url.includes("/inbox") ? "Открыть диалоги" : url.includes("tab=kb") ? "Открыть базу знаний" : url.includes("/review") ? "Открыть разбор" : "Открыть автотесты", url }]] } : undefined);
  } catch (e) {
    console.error("notify tests failed", e);
  }
}

/** Заявка из формы на сайте студии (api/widget/[channelId]/lead): кто, как связаться, что нужно, с какой страницы. */
export async function notifySiteLead(lead: { name: string; contact: string; need: string; page: string }, conversationId?: string) {
  try {
    const s = await getNotifySettings();
    await broadcast(
      [
        "📝 <b>Заявка с сайта</b>",
        `Имя: <b>${esc(lead.name)}</b>`,
        `Связь: <b>${esc(lead.contact)}</b>`,
        lead.need && `\n${esc(lead.need)}`,
        lead.page && `\n<i>Страница: ${esc(lead.page)}</i>`,
      ].filter(Boolean).join("\n"),
      conversationId ? openLink(s, conversationId) : undefined,
    );
  } catch (e) {
    console.error("notify site lead failed", e);
  }
}

/** Расходы ИИ студии за месяц дошли до 80% или 100% лимита из общих настроек. */
export async function notifyStudioLimit(spent: number, limit: number, level: 80 | 100) {
  try {
    await broadcast(
      [
        level === 100 ? "🔴 <b>Лимит расходов ИИ студии исчерпан</b>" : "🟡 <b>Расходы ИИ студии — 80% лимита</b>",
        `Потрачено в этом месяце: <b>$${spent.toFixed(2)}</b> из $${limit.toFixed(2)}.`,
        "Агенты продолжают работать: останавливают их только лимиты агента и клиента. Лимит меняется в «Настройках».",
      ].join("\n"),
    );
  } catch (e) {
    console.error("notify studio limit failed", e);
  }
}

/** Проверочное сообщение из «Интеграций». */
export async function notifyTest() {
  await broadcast("✅ Уведомления GenAgent работают. Сюда будут приходить передачи клиентов менеджеру, черновики на одобрение и сбои.");
}

// ---------- приём команд и нажатий ----------

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { first_name?: string; last_name?: string; username?: string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: { id: string; from: { first_name?: string }; data?: string; message?: { chat: { id: number }; message_id: number; text?: string } };
};

const poll = globalThis as unknown as { __notifyPoll?: { abort: AbortController; token: string } };

/** (Пере)запустить приём команд бота уведомлений — при старте и после смены токена. */
export function startNotifyPolling() {
  void (async () => {
    const s = await getNotifySettings();
    if (poll.__notifyPoll && poll.__notifyPoll.token === s?.token) return;
    poll.__notifyPoll?.abort.abort();
    poll.__notifyPoll = undefined;
    if (!s?.token) return;
    const abort = new AbortController();
    poll.__notifyPoll = { abort, token: s.token };
    let offset: number | undefined;
    let pause = 1000;
    while (!abort.signal.aborted) {
      try {
        const updates = await callTelegram<Update[]>(
          s.token,
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
          abort.signal,
        );
        pause = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch((e) => console.error("notify update failed", e));
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        if (e instanceof TelegramError && e.code === 401) {
          console.error("notify bot token rejected");
          return;
        }
        await new Promise((r) => setTimeout(r, pause));
        pause = Math.min(pause * 2, 60_000);
      }
    }
  })();
}

// Сотрудник нажал «Ответить»: следующее его сообщение уйдёт этому клиенту (15 минут или пока не ответит).
const REPLY_TTL_MS = 15 * 60 * 1000;
// Ответ на вопрос без ответа: кнопка «✍️ Ответить» → следующее сообщение (или «Ответить» на подсказку) уходит в базу знаний
const pendingAnswer = new Map<string, { gapId: string; at: number }>();
const promptToGap = new Map<string, string>();

async function answerGap(s: NotifySettings, chatId: string, gapId: string, text: string, isStudio: boolean) {
  const [row] = await db
    .select({ gap: knowledgeGaps, agent: agents, client: clients })
    .from(knowledgeGaps)
    .innerJoin(agents, eq(agents.id, knowledgeGaps.agentId))
    .innerJoin(clients, eq(clients.id, knowledgeGaps.clientId))
    .where(eq(knowledgeGaps.id, gapId));
  const owner = (s.owners ?? []).find((x) => x.chatId === chatId && x.clientId === row?.gap.clientId);
  if (!row || (!isStudio && !owner)) {
    pendingAnswer.delete(chatId);
    await send(s, chatId, "Вопрос не найден.");
    return;
  }
  const r = await addAnswerToKb(gapId, text);
  pendingAnswer.delete(chatId);
  if (r.error) {
    await send(s, chatId, r.error === "already" ? "На этот вопрос уже ответили." : r.error === "answer_short" ? "Слишком короткий ответ — напишите подробнее (нажмите «✍️ Ответить» ещё раз)." : `Не получилось: ${esc(r.error)}`);
    return;
  }
  await send(s, chatId, "✅ Спасибо! Ответ добавлен в базу знаний — помощник теперь отвечает на этот вопрос сам.");
  // Студия видит, что ответил владелец (может поправить в базе знаний)
  if (owner && !isStudio) {
    await broadcast(
      `📚 <b>Владелец ответил на вопрос агента</b>\n<b>${esc(row.client.name)}</b> · ${esc(row.agent.name)} · ${esc(owner.name)}\n\n❓ ${esc(row.gap.question.slice(0, 400))}\n💬 ${esc(text.slice(0, 1500))}`,
      s.adminUrl ? { inline_keyboard: [[{ text: "Открыть вопросы", url: `${s.adminUrl}/agents/${row.agent.id}/gaps` }]] } : undefined,
    );
  }
}

/** Ссылка подписки владельца клиента (код создаётся при первом запросе). null — бот уведомлений не настроен. */
export async function ownerLink(clientId: string, renew = false): Promise<string | null> {
  const s = await getNotifySettings();
  if (!s?.token || !s.botUsername) return null;
  let code = s.clientCodes?.[clientId];
  if (!code || renew) {
    code = newLinkCode();
    await setSetting(KEY, { ...s, clientCodes: { ...s.clientCodes, [clientId]: code } });
  }
  return `https://t.me/${s.botUsername}?start=c_${code}`;
}

export async function clientOwners(clientId: string): Promise<NotifyOwner[]> {
  return ((await getNotifySettings())?.owners ?? []).filter((x) => x.clientId === clientId);
}

export async function removeOwner(clientId: string, chatId: string) {
  const s = await getNotifySettings();
  if (!s) return;
  await setSetting(KEY, { ...s, owners: (s.owners ?? []).filter((x) => !(x.clientId === clientId && x.chatId === chatId)) });
}

const OWNER_GAPS = 7;

/** Вопросы без ответа — владельцам клиента (или одному владельцу): заголовок и по сообщению на вопрос с кнопками.
 *  Возвращает число отправленных вопросов. */
export async function sendGapsToOwners(clientId: string, opts: { chatId?: string } = {}): Promise<number> {
  const s = await getNotifySettings();
  if (!s?.token) return 0;
  const owners = (s.owners ?? []).filter((x) => x.clientId === clientId && (!opts.chatId || x.chatId === opts.chatId));
  if (!owners.length) return 0;
  // Не спрашивать владельца о том, что агент уже знает (документ добавили после вопроса)
  const { recheckClientGaps } = await import("@/lib/agent/gaps-recheck");
  await recheckClientGaps(clientId).catch(() => 0);
  const gaps = await db
    .select({ gap: knowledgeGaps, agent: agents.name })
    .from(knowledgeGaps)
    .innerJoin(agents, eq(agents.id, knowledgeGaps.agentId))
    .where(and(eq(knowledgeGaps.clientId, clientId), eq(knowledgeGaps.status, "open")))
    .orderBy(desc(knowledgeGaps.count), desc(knowledgeGaps.lastSeenAt))
    .limit(OWNER_GAPS);
  if (!gaps.length) return 0;
  const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
  for (const o of owners) {
    try {
      await send(
        s,
        o.chatId,
        `📚 <b>Вопросы клиентов без ответа</b>\n${esc(c?.name ?? "")}\n\nНа эти вопросы ИИ-помощник не нашёл ответа в своих знаниях. Ответьте на важные (кнопка «✍️ Ответить» под вопросом) — и помощник начнёт отвечать на них сам. Неактуальные можно пропустить.`,
      );
      for (const { gap } of gaps) {
        const draft = gap.suggestion ? `\n\n💡 <b>Ответ сотрудника, который можно сохранить:</b>\n<i>${esc(gap.suggestion.slice(0, 600))}</i>` : "";
        await send(s, o.chatId, `❓ ${esc(gap.question.slice(0, 500))}\n<i>спрашивали: ${gap.count} раз</i>${draft}`, {
          inline_keyboard: [
            [
              { text: "✍️ Ответить", callback_data: `ga:${gap.id}` },
              ...(gap.suggestion ? [{ text: "✅ Сохранить этот ответ", callback_data: `kb:${gap.id}` }] : []),
            ],
            [{ text: "Не актуально", callback_data: `kx:${gap.id}` }],
          ],
        });
      }
    } catch (e) {
      console.error("owner gaps send failed", o.chatId, e instanceof Error ? e.message : e);
    }
  }
  return gaps.length;
}
const pendingReply = new Map<string, { conversationId: string; at: number }>();
// Подсказка «Напишите ответ…» → разговор: ответ можно дать и через «Ответить» на эту подсказку в Telegram.
const promptToConversation = new Map<string, string>();

const REPLY_ERRORS: Record<string, string> = {
  api_reply_in_bot: "Этот бот принимает ответы менеджера только в самом боте — откройте диалог там.",
  not_found: "Разговор не найден — возможно, он удалён.",
  empty: "Пустой ответ не отправлен.",
};

/** Для проверок на копии базы (scripts/test-notify-reply.ts). */
export const handleNotifyUpdate = (u: Update) => handleUpdate(u);

async function handleUpdate(u: Update) {
  const s = await getNotifySettings();
  if (!s?.token) return;

  if (u.message?.text && u.message.chat.type === "private") {
    const chatId = String(u.message.chat.id);
    const [command, arg] = u.message.text.trim().split(/\s+/, 2);
    const ownerClient = arg?.startsWith("c_") ? Object.entries(s.clientCodes ?? {}).find(([, c]) => c === arg.slice(2))?.[0] : undefined;
    const isStudio = s.subscribers.some((x) => x.chatId === chatId);
    const isOwner = (s.owners ?? []).some((x) => x.chatId === chatId);
    if (command === "/start" && ownerClient) {
      const name = [u.message.from?.first_name, u.message.from?.last_name].filter(Boolean).join(" ") || u.message.from?.username || chatId;
      const owners = [...(s.owners ?? []).filter((x) => !(x.chatId === chatId && x.clientId === ownerClient)), { chatId, name, since: Date.now(), clientId: ownerClient }];
      await setSetting(KEY, { ...s, owners });
      const [c] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, ownerClient));
      await send(
        s,
        chatId,
        `✅ Готово! Раз в неделю сюда будут приходить вопросы клиентов «${esc(c?.name ?? "")}», на которые ИИ-помощник не знал ответа. Ответьте на важные — и помощник начнёт отвечать на них сам.\n\nОтписаться — /stop`,
      );
      await sendGapsToOwners(ownerClient, { chatId }).catch(() => 0);
      return;
    }
    if (command === "/start") {
      if (arg && arg === s.linkCode) {
        const name = [u.message.from?.first_name, u.message.from?.last_name].filter(Boolean).join(" ") || u.message.from?.username || chatId;
        const subscribers = [...s.subscribers.filter((x) => x.chatId !== chatId), { chatId, name, since: Date.now() }];
        await setSetting(KEY, { ...s, subscribers });
        await send(s, chatId, "✅ Подписка на уведомления GenAgent оформлена. Отписаться — /stop");
      } else if (isStudio || isOwner) {
        await send(s, chatId, "Вы уже подписаны. Отписаться — /stop");
      } else {
        await send(s, chatId, "Чтобы получать уведомления, откройте ссылку подписки из раздела «Интеграции» в GenAgent.");
      }
    } else if (command === "/stop") {
      await setSetting(KEY, { ...s, subscribers: s.subscribers.filter((x) => x.chatId !== chatId), owners: (s.owners ?? []).filter((x) => x.chatId !== chatId) });
      await send(s, chatId, "Вы отписались от уведомлений.");
    } else if (command === "/cancel") {
      pendingReply.delete(chatId);
      pendingAnswer.delete(chatId);
      await send(s, chatId, "Ответ отменён.");
    } else if ((isStudio || isOwner) && !command.startsWith("/")) {
      // Ответ на вопрос без ответа (кнопка «✍️ Ответить» под вопросом или «Ответить» на подсказку) — в базу знаний
      const viaGap = u.message.reply_to_message && promptToGap.get(`${chatId}:${u.message.reply_to_message.message_id}`);
      const pa = pendingAnswer.get(chatId);
      const gapId = viaGap || (pa && Date.now() - pa.at < REPLY_TTL_MS ? pa.gapId : null);
      if (gapId) {
        await answerGap(s, chatId, gapId, u.message.text, isStudio);
        return;
      }
      // Ответ клиенту: «Ответить» на подсказку или первое сообщение после кнопки «Ответить»
      const viaReply = u.message.reply_to_message && promptToConversation.get(`${chatId}:${u.message.reply_to_message.message_id}`);
      const pending = pendingReply.get(chatId);
      const conversationId = viaReply || (pending && Date.now() - pending.at < REPLY_TTL_MS ? pending.conversationId : null);
      if (!isStudio) {
        // Владелец отвечает только клиентам своего бизнеса (разговор ему назначен распределением заявок)
        const [conv] = conversationId ? await db.select({ clientId: conversations.clientId }).from(conversations).where(eq(conversations.id, conversationId)) : [];
        if (!conv || !(s.owners ?? []).some((o) => o.chatId === chatId && o.clientId === conv.clientId)) {
          await send(s, chatId, "Чтобы ответить на вопрос, нажмите «✍️ Ответить» под ним.");
          return;
        }
      }
      if (!conversationId) {
        await send(s, chatId, "Чтобы ответить клиенту, нажмите «✍️ Ответить» под уведомлением о нём.");
        return;
      }
      const row = await conversationInfo(conversationId);
      const r = await operatorReplyCore(conversationId, u.message.text);
      if (r.error) {
        await send(s, chatId, `❌ Не отправлено: ${esc(REPLY_ERRORS[r.error] ?? r.error.slice(0, 200))}`);
        return;
      }
      pendingReply.delete(chatId);
      const who = row ? esc(row.conversation.contactName || row.conversation.contactHandle || "клиенту") : "клиенту";
      await send(s, chatId, `✅ Отправлено: ${who}. Агент молчит, пока вы ведёте разговор.`, row ? { inline_keyboard: [[{ text: "✍️ Ответить ещё", callback_data: `rp:${conversationId}` }, { text: "🤖 Вернуть агенту", callback_data: `rt:${conversationId}` }]] } : undefined);
    }
    return;
  }

  const q = u.callback_query;
  if (!q?.data || !q.message) return;
  const chatId = String(q.message.chat.id);
  const answer = (text: string) => callTelegram(s.token, "answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  // Нажимать кнопки могут только подписчики (ссылка подписки — секрет студии) и владельцы — лишь у вопросов своего клиента.
  const isStudio = s.subscribers.some((x) => x.chatId === chatId);
  const ownClients = (s.owners ?? []).filter((x) => x.chatId === chatId).map((x) => x.clientId);
  if (!isStudio && !ownClients.length) return answer("Нет доступа");
  const [action, messageId] = q.data.split(":");
  if (!/^[0-9a-f-]{36}$/.test(messageId ?? "")) return answer("Неизвестная кнопка");
  if (!isStudio && !["ga", "kx", "kb", "ap", "ax", "rp", "rt", "sd", "br"].includes(action)) return answer("Нет доступа");
  if (!isStudio && (action === "rp" || action === "rt" || action === "sd" || action === "br")) {
    const [conv] = await db.select({ clientId: conversations.clientId }).from(conversations).where(eq(conversations.id, messageId));
    if (!conv || !ownClients.includes(conv.clientId)) return answer("Нет доступа");
  }
  if (action === "ap" || action === "ax") {
    const [a] = await db.select().from(approvals).where(eq(approvals.id, messageId));
    if (!a) return answer("Заявка не найдена");
    if (!isStudio && !ownClients.includes(a.clientId)) return answer("Нет доступа");
    const { decideApproval } = await import("@/lib/team/approvals");
    const who = q.from.first_name || "руководитель";
    const done = await decideApproval(a.id, action === "ap", who);
    if (!done) return answer(a.status === "approved" ? "Уже согласовано" : "Уже отказано");
    await answer(action === "ap" ? "Согласовано — сотрудник получит ответ" : "Отказано — сотрудник получит ответ");
    await markDone(s, q, `${action === "ap" ? "✅ Согласовано" : "❌ Отказано"} · ${who}`);
    return;
  }
  if (action === "ga" || action === "kx" || action === "kb") {
    const [gap] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, messageId));
    if (gap && !isStudio && !ownClients.includes(gap.clientId)) return answer("Нет доступа");
  }
  if (action === "ga") {
    const [gap] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, messageId));
    if (!gap || gap.status !== "open") return answer("Уже обработано");
    pendingAnswer.set(chatId, { gapId: messageId, at: Date.now() });
    pendingReply.delete(chatId);
    await answer("Напишите ответ");
    const prompt = await send(
      s,
      chatId,
      `✍️ Напишите ответ на вопрос «${esc(gap.question.slice(0, 300))}» одним сообщением — так, как ответили бы клиенту. Он попадёт в базу знаний помощника. Отмена — /cancel`,
      { force_reply: true, input_field_placeholder: "Ответ на вопрос" },
    );
    promptToGap.set(`${chatId}:${prompt.message_id}`, messageId);
    if (promptToGap.size > 500) promptToGap.delete(promptToGap.keys().next().value as string);
    return;
  }
  if (action === "br") {
    await answer("Готовлю бриф…");
    const { callBrief } = await import("@/lib/agent/brief");
    const text = await callBrief(messageId).catch(() => null);
    const row = await conversationInfo(messageId);
    await send(s, chatId, text ? `📋 <b>Бриф перед звонком</b>${row ? `\n${header(row)}` : ""}\n\n${esc(text).replace(/^##\s*(.+)$/gm, "<b>$1</b>").slice(0, 3800)}` : "Не получилось подготовить бриф — попробуйте ещё раз.");
    return;
  }
  if (action === "rp") {
    const row = await conversationInfo(messageId);
    if (!row) return answer("Разговор не найден");
    pendingReply.set(chatId, { conversationId: messageId, at: Date.now() });
    await answer("Напишите ответ");
    const who = row.conversation.contactName || row.conversation.contactHandle || "клиенту";
    const prompt = await send(s, chatId, `✍️ Напишите ответ ${esc(who)} одним сообщением — он уйдёт клиенту. Отмена — /cancel`, { force_reply: true, input_field_placeholder: "Ответ клиенту" });
    promptToConversation.set(`${chatId}:${prompt.message_id}`, messageId);
    if (promptToConversation.size > 500) promptToConversation.delete(promptToConversation.keys().next().value as string);
    return;
  }
  if (action === "sd") {
    // Отправить клиенту черновик ответа, который агент подготовил при передаче
    const [conv] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, messageId));
    const draft = conv?.context?.managerDraft?.text;
    if (!draft) return answer("Черновик уже отправлен или устарел");
    const r = await operatorReplyCore(messageId, draft);
    if (r.error) return answer(r.error === "not_found" ? "Разговор не найден" : "Не получилось: " + r.error.slice(0, 150));
    await answer("Отправлено клиенту");
    await markDone(s, q, `📤 Черновик отправлен · ${q.from.first_name || "менеджер"}`);
    return;
  }
  if (action === "kb" || action === "kx") {
    const [gap] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, messageId));
    if (!gap || gap.status !== "open") return answer("Уже обработано");
    if (action === "kx") {
      await db.update(knowledgeGaps).set({ status: "ignored" }).where(eq(knowledgeGaps.id, messageId));
      await answer("Хорошо, не добавляем");
      await markDone(s, q, `✖️ Не нужно · ${q.from.first_name || "менеджер"}`);
      return;
    }
    const r = await addAnswerToKb(messageId, gap.suggestion ?? "");
    if (r.error) return answer("Не получилось: " + r.error);
    await answer("Добавлено — агент будет отвечать сам");
    await markDone(s, q, `✅ В базе знаний · ${q.from.first_name || "менеджер"}`);
    return;
  }
  if (action === "rt") {
    const r = await returnToAgentCore(messageId);
    pendingReply.delete(chatId);
    await answer(r.error ? "Разговор не найден" : "Агент снова отвечает");
    if (!r.error) await send(s, chatId, "🤖 Разговор возвращён агенту — он снова отвечает клиенту.");
    return;
  }
  const result = action === "ap" ? await approveDraftCore(messageId) : action === "rj" ? await rejectDraftCore(messageId) : { error: "unknown" };
  const who = q.from.first_name || "менеджер";
  if (result.error === "not_found") {
    await answer("Этот черновик уже обработан");
  } else if (result.error) {
    await answer("Не получилось: " + result.error.slice(0, 150));
    return;
  } else {
    await answer(action === "ap" ? "Опубликовано" : "Отклонено");
  }
  const mark = result.error === "not_found" ? "ℹ️ Уже обработан" : action === "ap" ? `✅ Опубликовано · ${who}` : `✖️ Отклонено · ${who}`;
  await callTelegram(s.token, "editMessageText", {
    chat_id: chatId,
    message_id: q.message.message_id,
    text: `${(q.message.text ?? "").slice(0, 3500)}\n\n${mark}`,
    link_preview_options: { is_disabled: true },
  }).catch(() => {});
}
