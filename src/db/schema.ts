import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentConfig } from "@/lib/agent/types";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  createdAt: createdAt(),
});

// Клиент студии = рабочее пространство: свой бренд, свои агенты, каналы и база знаний.
export const clients = sqliteTable("clients", {
  id: id(),
  name: text("name").notNull(),
  industry: text("industry").notNull().default(""),
  website: text("website").notNull().default(""),
  description: text("description").notNull().default(""),
  brandVoice: text("brand_voice").notNull().default(""),
  color: text("color").notNull().default("#6366f1"),
  createdAt: createdAt(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "active", "paused"] })
      .notNull()
      .default("draft"),
    templateKey: text("template_key"),
    config: text("config", { mode: "json" }).$type<AgentConfig>().notNull(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("agents_client_idx").on(t.clientId)],
);

// Каждое сохранение агента пишет снимок — основа для истории версий и отката.
export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name"),
    config: text("config", { mode: "json" }).$type<AgentConfig>().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("agent_versions_agent_idx").on(t.agentId)],
);

// База знаний клиента: источники (файл, сайт, текст) и их фрагменты для поиска.
// Полнотекстовый индекс kb_chunks_fts (FTS5) создаётся отдельной миграцией — drizzle не описывает виртуальные таблицы.
export const kbSources = sqliteTable(
  "kb_sources",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["file", "url", "text"] }).notNull(),
    title: text("title").notNull(),
    url: text("url"),
    crawl: text("crawl", { enum: ["page", "site"] }),
    filename: text("filename"),
    status: text("status", { enum: ["processing", "ready", "error"] })
      .notNull()
      .default("processing"),
    error: text("error"),
    content: text("content").notNull().default(""),
    chars: integer("chars").notNull().default(0),
    chunks: integer("chunks").notNull().default(0),
    pages: integer("pages").notNull().default(0),
    /** Источник, который присылает свой бот клиента (синхронизация): ключ документа у бота, например objects */
    externalKey: text("external_key"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("kb_sources_client_idx").on(t.clientId), index("kb_sources_external_idx").on(t.clientId, t.externalKey)],
);

export const kbChunks = sqliteTable(
  "kb_chunks",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => kbSources.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    idx: integer("idx").notNull(),
    text: text("text").notNull(),
    /** Смысловой «отпечаток» фрагмента (Float32, 384 числа) для смыслового поиска; null — ещё не посчитан. */
    embedding: blob("embedding", { mode: "buffer" }),
  },
  (t) => [index("kb_chunks_source_idx").on(t.sourceId)],
);

// ---------- настройки студии и авторизация в сервисах ----------

/** Настройки студии (ключи приложений Meta и т.п.): ключ → JSON. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Одноразовое «состояние» авторизации (OAuth): связывает возврат из Instagram/Threads
 * с агентом, для которого подключали аккаунт. Живёт час.
 */
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider", { enum: ["instagram", "threads"] }).notNull(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// ---------- каналы и диалоги ----------

export type TelegramConfig = {
  token: string;
  username: string;
  botName: string;
  offset?: number;
  /** Ответы на комментарии под постами канала (бот — администратор группы обсуждений канала) */
  comments?: boolean;
  /** Ответы в комментариях — сначала на одобрение менеджеру */
  approval?: boolean;
  /** Группа обсуждений, откуда последний раз пришёл комментарий (для показа в настройках) */
  group?: { id: number; title: string; channel?: string };
};
export type WidgetConfig = {
  title: string;
  subtitle: string;
  color: string;
  position: "right" | "left";
  /** Бот клиента в Telegram (username без @): в окне чата — «Продолжить в Telegram» с переносом разговора */
  telegramBot?: string;
};
/** Аккаунт Instagram (вход через Instagram): директ и/или комментарии. */
export type InstagramConfig = {
  igUserId: string;
  username: string;
  token: string;
  tokenExpiresAt: number;
  dm: boolean;
  comments: boolean;
  /** Ответы в комментариях — сначала на одобрение менеджеру. */
  approval: boolean;
  /** Время последней проверки комментариев (секунды), для опроса без вебхуков. */
  since?: number;
};
/** Аккаунт Threads: ответы на реплаи к постам аккаунта. */
export type ThreadsConfig = {
  threadsUserId: string;
  username: string;
  token: string;
  tokenExpiresAt: number;
  approval: boolean;
  /** Время последней проверки ответов (секунды), для опроса без вебхуков. */
  since?: number;
};
/** Почтовый ящик (Gmail и др.): чтение по IMAP, ответы по SMTP, вход паролем приложения. */
export type EmailConfig = {
  address: string;
  /** Пароль приложения (Gmail: «Пароли приложений», нужна двухэтапная проверка) */
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Подпись отправителя в письмах, например «Studio YABOT» */
  fromName: string;
  /** Ответы сначала на одобрение менеджеру. */
  approval: boolean;
  /** Последнее обработанное письмо (UID) и UIDVALIDITY ящика — новые письма идут после него. */
  lastUid?: number;
  uidValidity?: string;
};
/**
 * Свой бот клиента (API): бот сам ведёт переписку, а за ответом на вопрос обращается к агенту.
 * Агент не переводит диалог в режим менеджера — когда звать человека, решает бот по флагу handoff.
 */
export type ApiConfig = {
  /** Ключ доступа (Bearer) — его вписывают в настройки бота */
  key: string;
  /** Как называть подключённый бот в студии, например @construcciones_kornilenko_bot */
  label: string;
  /** Комментарии, которые присылает бот (POST /comment): ответы сначала на одобрение. По умолчанию — да. */
  approval?: boolean;
  /** Что умеет бот (кнопки, разделы) — агент может советовать ими воспользоваться */
  botNote?: string;
  /** Когда бот впервые забрал ответы менеджера (/outbox?kinds=dm) — значит, из «Диалогов» можно писать его клиентам */
  dmAt?: number;
  /** Напоминания тем, кто поговорил с агентом и ушёл ни с чем (бот забирает их из /outbox, kind: followup) */
  followUps?: boolean;
  /** Агент сопровождает заказ: при смене статуса бот берёт у агента живой текст вместо шаблона (POST /order) */
  orderNotes?: boolean;
};
export type ChannelConfig = TelegramConfig | WidgetConfig | InstagramConfig | ThreadsConfig | EmailConfig | ApiConfig;
export const CHANNEL_TYPES = ["telegram", "widget", "instagram", "threads", "email", "api"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Канал, через который агент общается с клиентами: Telegram-бот или виджет на сайте. */
export const channels = sqliteTable(
  "channels",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    type: text("type", { enum: CHANNEL_TYPES }).notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    config: text("config", { mode: "json" }).$type<ChannelConfig>().notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("channels_agent_idx").on(t.agentId)],
);

/** Переписка с одним человеком в одном канале. */
export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    clientId: text("client_id").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    channelType: text("channel_type", { enum: CHANNEL_TYPES }).notNull(),
    /** dm — личные сообщения, comment — ветка комментариев/ответов под постом */
    kind: text("kind", { enum: ["dm", "comment"] }).notNull().default("dm"),
    /** Для комментариев: к какому посту и на какой комментарий отвечаем. */
    context: text("context", { mode: "json" }).$type<ConversationContext>(),
    /** id чата в Telegram или посетителя виджета */
    externalId: text("external_id").notNull(),
    contactName: text("contact_name").notNull().default(""),
    contactHandle: text("contact_handle").notNull().default(""),
    /** ai — отвечает агент, human — диалог ведёт менеджер */
    mode: text("mode", { enum: ["ai", "human"] }).notNull().default("ai"),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    needsAttention: integer("needs_attention", { mode: "boolean" }).notNull().default(false),
    unread: integer("unread").notNull().default(0),
    lastMessageText: text("last_message_text").notNull().default(""),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversations_channel_external_idx").on(t.channelId, t.externalId),
    index("conversations_last_idx").on(t.lastMessageAt),
  ],
);

export type OrderState = {
  id: string;
  title: string;
  status: string;
  label: string;
  /** Факты от бота: срок, сумма, аптека… — одной строкой */
  facts: string;
  at: number;
  steps: { label: string; at: number }[];
};

export type ConversationContext = {
  postId?: string;
  postUrl?: string;
  postText?: string;
  /** id комментария/ответа, на который отвечает агент (для почты — Message-ID последнего письма) */
  replyToId?: string;
  /** Почта: тема переписки и цепочка Message-ID для ответа в той же ветке */
  subject?: string;
  references?: string;
  /** Telegram: группа обсуждений канала, где идёт ветка комментариев */
  chatId?: string;
  /** Когда последний раз решали про напоминание этому клиенту (не чаще раза в неделю) */
  followUpAt?: number;
  /** Свой бот: заказы клиента и как менялся их статус (POST /order) — агент видит их в контексте */
  orders?: OrderState[];
  /** Свой бот (API): язык, на котором отвечать клиенту, и что клиент сейчас смотрит в боте */
  language?: string;
  botContext?: string;
  /** Виджет: одноразовый код ссылки «Продолжить в Telegram» и когда выдан */
  linkToken?: string;
  linkAt?: number;
  /** Разговор продолжен в боте (id разговора там) / пришёл с сайта (id разговора виджета) */
  linkedTo?: string;
  linkedFrom?: string;
};

export type MessageMeta = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  ms?: number;
  kb?: { mode: "full" | "search"; sources: string[] } | null;
  error?: string;
  handoff?: boolean;
  /** Передача менеджеру: выжимка разговора для него */
  summary?: string;
  /** Передача менеджеру: клиент недоволен (метка [[ACTION mood: upset]]) — срочно */
  upset?: boolean;
  /** Инструменты, вызванные агентом при ответе (например, запись в календарь) */
  tools?: { name: string; error?: boolean }[];
  /** Действия для своего бота из меток [[ACTION тип: значение]] — например, проверить препарат в аптеке */
  actions?: { type: string; value: string }[];
  /** Напоминание агента клиенту, который ушёл ни с чем */
  followUp?: boolean;
  /** Сообщение агента о смене статуса заказа (бот отправил его вместо шаблона) */
  orderNote?: boolean;
  /** Проверяемые факты ответа (цены, телефоны, ссылки), которых нет в базе знаний и переписке */
  unverified?: string[];
  /** Сообщение перенесено из разговора на сайте (виджет), когда клиент перешёл в бота */
  fromSite?: boolean;
  /** Оценка ответа клиентом в боте (👍/👎) */
  rating?: "up" | "down";
  /** Из журнала своего бота: что это было (photo, sticker, voice, button, reaction…) — для значка в переписке */
  kind?: string;
  /** Превью картинки (файл в папке media рядом с базой) — показываем в «Диалогах» */
  thumb?: string;
  /** Что на фото клиента (описание дешёвой моделью) — агент отвечает с учётом этого */
  vision?: string;
};

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /**
     * user — клиент, assistant — агент, operator — менеджер студии, system — служебное,
     * bot — сам бот клиента (меню, шаблоны, уведомления): видно в переписке, но не ответ агента и не память ИИ
     */
    role: text("role", { enum: ["user", "assistant", "operator", "system", "bot"] }).notNull(),
    text: text("text").notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    meta: text("meta", { mode: "json" }).$type<MessageMeta>(),
    /** sent — доставлено/опубликовано; draft — ждёт одобрения менеджера; rejected — отклонено */
    status: text("status", { enum: ["sent", "draft", "rejected"] }).notNull().default("sent"),
    /** id сообщения/комментария в соцсети — чтобы не принять одно событие дважды */
    externalId: text("external_id"),
    /** Номер сообщения в своём боте клиента (журнал переписки): повторная досылка не задваивает */
    botId: text("bot_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("messages_external_idx").on(t.externalId),
    uniqueIndex("messages_bot_idx").on(t.conversationId, t.botId),
  ],
);

// ---------- расходы на модели ----------

/** Каждый вызов модели: откуда, какой агент/клиент, токены и стоимость. Основа аналитики расходов и лимитов. */
export const usageLog = sqliteTable(
  "usage_log",
  {
    id: id(),
    source: text("source", { enum: ["channel", "playground", "test", "generate", "insights"] }).notNull(),
    clientId: text("client_id"),
    agentId: text("agent_id"),
    conversationId: text("conversation_id"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** USD; null — цена модели неизвестна (OpenAI/OpenRouter вне каталога) */
    cost: real("cost"),
    ms: integer("ms"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_agent_idx").on(t.agentId, t.createdAt), index("usage_created_idx").on(t.createdAt)],
);

// ---------- автотесты агентов ----------

export type ScenarioCriterion = { text: string };

/** Сценарий проверки: реплики клиента (или описание клиента для симуляции) и критерии для ИИ-судьи. */
export const testScenarios = sqliteTable(
  "test_scenarios",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** script — заданные реплики клиента; simulate — клиента играет модель по описанию */
    mode: text("mode", { enum: ["script", "simulate"] }).notNull().default("script"),
    /** Реплики клиента (script) */
    turns: text("turns", { mode: "json" }).$type<string[]>().notNull(),
    /** Кто клиент и чего хочет (simulate) */
    persona: text("persona").notNull().default(""),
    maxTurns: integer("max_turns").notNull().default(4),
    criteria: text("criteria", { mode: "json" }).$type<ScenarioCriterion[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("test_scenarios_agent_idx").on(t.agentId)],
);

export const testRuns = sqliteTable(
  "test_runs",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    agentVersion: integer("agent_version").notNull(),
    status: text("status", { enum: ["running", "done", "error"] }).notNull().default("running"),
    total: integer("total").notNull().default(0),
    passed: integer("passed").notNull().default(0),
    /** Средняя оценка судьи 1–10 */
    score: real("score"),
    cost: real("cost").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("test_runs_agent_idx").on(t.agentId, t.createdAt)],
);

export type TestVerdict = { criterion: string; pass: boolean; comment: string };

export const testResults = sqliteTable(
  "test_results",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id"),
    scenarioName: text("scenario_name").notNull(),
    transcript: text("transcript", { mode: "json" })
      .$type<{ role: "user" | "assistant"; content: string }[]>()
      .notNull(),
    verdicts: text("verdicts", { mode: "json" }).$type<TestVerdict[]>().notNull(),
    score: real("score"),
    passed: integer("passed", { mode: "boolean" }).notNull().default(false),
    summary: text("summary").notNull().default(""),
    error: text("error"),
    cost: real("cost").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("test_results_run_idx").on(t.runId)],
);

// ---------- записи в календарь ----------

/** Записи, которые агент создал в Google Календаре клиента. */
export const bookings = sqliteTable(
  "bookings",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    calendarId: text("calendar_id").notNull(),
    eventId: text("event_id").notNull(),
    eventLink: text("event_link"),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }).notNull(),
    service: text("service").notNull().default(""),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    comment: text("comment").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("bookings_agent_idx").on(t.agentId, t.createdAt), index("bookings_client_idx").on(t.clientId, t.createdAt)],
);

export type Booking = typeof bookings.$inferSelect;

// ---------- вопросы без ответа ----------

/**
 * Вопросы клиентов, на которые агент не смог ответить по существу (не хватило базы знаний).
 * Находит ежедневный разбор переписок; похожие вопросы склеиваются, count — сколько раз спрашивали.
 */
export const knowledgeGaps = sqliteTable(
  "knowledge_gaps",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    /** Какой информации не хватило */
    missing: text("missing").notNull().default(""),
    count: integer("count").notNull().default(1),
    /** Примеры: диалог и цитата клиента */
    examples: text("examples", { mode: "json" }).$type<{ conversationId: string; quote: string; at: number }[]>().notNull(),
    status: text("status", { enum: ["open", "resolved", "ignored"] }).notNull().default("open"),
    answer: text("answer"),
    /** Готовый ответ для базы знаний из того, что ответил клиенту сотрудник (предлагается, пока вопрос открыт) */
    suggestion: text("suggestion"),
    createdAt: createdAt(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("knowledge_gaps_agent_idx").on(t.agentId, t.status)],
);

export type KnowledgeGap = typeof knowledgeGaps.$inferSelect;

/**
 * События воронки от своего бота: что клиент сделал (бриф отправлен, заявка, просмотр, бронь, оплата…)
 * и оценки ответов агента (👍/👎). По ним считается, сколько разговоров с агентом стали результатом.
 */
export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    /** Разговор с агентом этого клиента в этом канале (если был) */
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** id клиента в боте */
    externalUserId: text("external_user_id").notNull(),
    /** Код события: brief_sent, inquiry, viewing, deal, check, order, reserved, paid, rating_up, rating_down… */
    type: text("type").notNull(),
    /** Название для отчёта, как его прислал бот («Бриф отправлен») */
    label: text("label").notNull().default(""),
    /** Сумма (оплата, сделка), если есть */
    value: real("value"),
    /** Был ли у клиента разговор с агентом за 14 дней до события */
    assisted: integer("assisted", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("agent_events_agent_idx").on(t.agentId, t.createdAt)],
);
export type User = typeof users.$inferSelect;
export type TestScenario = typeof testScenarios.$inferSelect;
export type TestRun = typeof testRuns.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type KbSource = typeof kbSources.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Agent = typeof agents.$inferSelect;
