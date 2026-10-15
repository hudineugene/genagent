import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { callTelegram, TelegramError } from "@/lib/channels/telegram-api";
import { approveDraftCore, rejectDraftCore } from "@/lib/drafts";

/**
 * Уведомления студии в Telegram — отдельный бот (его создают в @BotFather).
 * Сотрудник подписывается ссылкой t.me/<бот>?start=<код> из «Интеграций», отписывается командой /stop.
 * Что приходит: клиент передан менеджеру (с выжимкой), черновик ждёт одобрения (с кнопками), сбои каналов и агентов.
 */
export type NotifySubscriber = { chatId: string; name: string; since: number };
export type NotifySettings = {
  token: string;
  botUsername: string;
  /** Секрет ссылки подписки: без него подписаться нельзя */
  linkCode: string;
  /** Адрес админки для ссылок «Открыть диалог» (Tailscale) */
  adminUrl: string;
  subscribers: NotifySubscriber[];
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

/** Агент передал клиента менеджеру. */
export async function notifyHandoff(conversationId: string, summary: string | null) {
  try {
    const row = await conversationInfo(conversationId);
    if (!row) return;
    const s = await getNotifySettings();
    const note =
      row.channel.type === "api" ? "\n<i>Заявка создана в боте клиента — отвечает его менеджер.</i>" : "";
    await broadcast(
      `🙋 <b>Клиент передан менеджеру</b>\n${header(row)}\n\n${summary ? esc(summary) : "<i>Выжимки нет — откройте диалог.</i>"}${note}`,
      openLink(s, conversationId),
    );
  } catch (e) {
    console.error("notify handoff failed", e);
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
      `📝 <b>Черновик ответа ждёт одобрения</b>\n${header(row)}\n\n${question ? `💬 ${esc(question.text.slice(0, 600))}\n\n` : ""}🤖 ${esc(m.text.slice(0, 2500))}`,
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
    } else if (context.channelId) {
      const [row] = await db
        .select({ channel: channels, client: clients })
        .from(channels)
        .innerJoin(clients, eq(clients.id, channels.clientId))
        .where(eq(channels.id, context.channelId));
      if (row) where = `<b>${esc(row.client.name)}</b> · ${esc(CHANNEL_LABEL[row.channel.type] ?? row.channel.type)} ${esc(row.channel.name)}`;
    }
    const text = PROBLEM_TEXT[code.split(":")[0]] ?? `ошибка: ${code.slice(0, 200)}`;
    await broadcast(`⚠️ <b>Сбой</b>\n${where}\n\n${esc(text)}`, context.conversationId ? openLink(s, context.conversationId) : undefined);
  } catch (e) {
    console.error("notify problem failed", e);
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

/** Отчёт еженедельной проверки агентов (автотесты). */
export async function notifyTestsReport(html: string, url?: string) {
  try {
    await broadcast(html, url ? { inline_keyboard: [[{ text: url.includes("/analytics") ? "Открыть аналитику" : "Открыть автотесты", url }]] } : undefined);
  } catch (e) {
    console.error("notify tests failed", e);
  }
}

/** Проверочное сообщение из «Интеграций». */
export async function notifyTest() {
  await broadcast("✅ Уведомления GenAgent работают. Сюда будут приходить передачи клиентов менеджеру, черновики на одобрение и сбои.");
}

// ---------- приём команд и нажатий ----------

type Update = {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { first_name?: string; last_name?: string; username?: string }; text?: string };
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

async function handleUpdate(u: Update) {
  const s = await getNotifySettings();
  if (!s?.token) return;

  if (u.message?.text && u.message.chat.type === "private") {
    const chatId = String(u.message.chat.id);
    const [command, arg] = u.message.text.trim().split(/\s+/, 2);
    if (command === "/start") {
      if (arg && arg === s.linkCode) {
        const name = [u.message.from?.first_name, u.message.from?.last_name].filter(Boolean).join(" ") || u.message.from?.username || chatId;
        const subscribers = [...s.subscribers.filter((x) => x.chatId !== chatId), { chatId, name, since: Date.now() }];
        await setSetting(KEY, { ...s, subscribers });
        await send(s, chatId, "✅ Подписка на уведомления GenAgent оформлена. Отписаться — /stop");
      } else if (s.subscribers.some((x) => x.chatId === chatId)) {
        await send(s, chatId, "Вы уже подписаны. Отписаться — /stop");
      } else {
        await send(s, chatId, "Чтобы получать уведомления, откройте ссылку подписки из раздела «Интеграции» в GenAgent.");
      }
    } else if (command === "/stop") {
      await setSetting(KEY, { ...s, subscribers: s.subscribers.filter((x) => x.chatId !== chatId) });
      await send(s, chatId, "Вы отписались от уведомлений.");
    }
    return;
  }

  const q = u.callback_query;
  if (!q?.data || !q.message) return;
  const chatId = String(q.message.chat.id);
  const answer = (text: string) => callTelegram(s.token, "answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  // Нажимать кнопки могут только подписчики (ссылка подписки — секрет студии).
  if (!s.subscribers.some((x) => x.chatId === chatId)) return answer("Нет доступа");
  const [action, messageId] = q.data.split(":");
  if (!/^[0-9a-f-]{36}$/.test(messageId ?? "")) return answer("Неизвестная кнопка");
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
