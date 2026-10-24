import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentConfig } from "@/lib/agent/types";
import { CONTENT_KINDS, CONTENT_PLATFORMS } from "@/lib/content/kinds";

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
  /** client — владелец бизнеса клиента: только кабинет своего бизнеса (/portal), студия закрыта */
  role: text("role", { enum: ["admin", "member", "client"] }).notNull().default("member"),
  /** Двухфакторный вход (TOTP): секрет зашифрован ключом сессий; коды восстановления — хэши, каждый на один раз */
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  recoveryCodes: text("recovery_codes", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** Доступ сотрудника только к этим клиентам; null — ко всем (администратор видит всех всегда) */
  clientIds: text("client_ids", { mode: "json" }).$type<string[] | null>(),
  /** Растёт при смене или сбросе пароля и сбросе второго фактора: сессии со старым номером больше не действуют */
  sessionVersion: integer("session_version").notNull().default(0),
  /** Последний принятый шаг кода из приложения: тот же код второй раз не принимается */
  totpLastStep: integer("totp_last_step").notNull().default(0),
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
  /** Свои ключи клиента (его аккаунты ИИ и Google Maps): заданы — работа для клиента идёт за его счёт */
  apiKeys: text("api_keys", { mode: "json" }).$type<Partial<Record<"anthropic" | "openai" | "openrouter" | "googleMaps", string>>>().notNull().default({}),
  /** Срок хранения разговоров, дней (GDPR); null — бессрочно */
  retentionDays: integer("retention_days"),
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

/**
 * Шаблон агента студии: проверенная настройка (роль, тон, правила, проверки, модель…) без данных клиента.
 * Агенты из шаблона помнят его версию; новые версии шаблона студия раскатывает выборочно — по агентам и полям.
 */
export const studioTemplates = sqliteTable("studio_templates", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  config: text("config", { mode: "json" }).$type<AgentConfig>().notNull(),
  version: integer("version").notNull().default(1),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type StudioTemplate = typeof studioTemplates.$inferSelect;

// База знаний клиента: источники (файл, сайт, текст) и их фрагменты для поиска.
// Полнотекстовый индекс kb_chunks_fts (FTS5) создаётся отдельной миграцией — drizzle не описывает виртуальные таблицы.
/** Параметр своего инструмента: что агент передаёт при вызове. */
export type ToolParam = { name: string; type: "string" | "number" | "boolean"; description: string; required: boolean };

/**
 * Свой инструмент клиента: внешняя система по HTTP (CRM, склад, статус заказа, калькулятор…), которую агент вызывает
 * сам. Заводится в админке без программиста; секреты (ключи в заголовках) хранятся здесь, а не в версиях агента.
 */
export const clientTools = sqliteTable(
  "client_tools",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** http — запрос к API; sheet — поиск строк в Google Таблице (url — ссылка на таблицу, sheet — лист);
     *  mcp — MCP-сервер (url, авторизация в headers): агенту доступны все его инструменты; crm — готовое подключение к CRM */
    kind: text("kind", { enum: ["http", "sheet", "mcp", "crm"] }).notNull().default("http"),
    /** CRM: система, ключи, домен, передавать ли заявки из диалогов (секреты не уходят в браузер) */
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    sheet: text("sheet"),
    /** Имя для модели: латиница, snake_case */
    name: text("name").notNull(),
    /** Название для людей */
    title: text("title").notNull(),
    /** Когда и зачем вызывать — это читает агент */
    description: text("description").notNull().default(""),
    method: text("method", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }).notNull().default("GET"),
    /** Адрес; {параметр} подставляется из вызова */
    url: text("url").notNull(),
    headers: text("headers", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    params: text("params", { mode: "json" }).$type<ToolParam[]>().notNull().default([]),
    /** Только чтение: в тест-чате и автотестах вызывается по-настоящему; иначе там лишь показывается, что было бы отправлено */
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Итог последнего вызова: «200», «timeout», «error: …» */
    lastStatus: text("last_status"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("client_tools_client_idx").on(t.clientId)],
);
export type ClientTool = typeof clientTools.$inferSelect;

export { INTEGRATION_EVENTS, type IntegrationEventType } from "@/lib/integrations/types";
import type { IntegrationEventType } from "@/lib/integrations/types";

export type IntegrationConfig =
  /** Google Таблица: ссылка, лист */
  | { url: string; sheet: string }
  /** Вебхук: адрес и секрет для подписи (X-GenAgent-Signature: sha256=…) */
  | { url: string; secret: string };

/**
 * Отправка данных клиента во внешние системы: заявки, передачи менеджеру, записи, оценки и события бота —
 * строками в Google Таблицу или запросом на вебхук (любая CRM, Make, Zapier, n8n…).
 */
export const clientIntegrations = sqliteTable(
  "client_integrations",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["sheet", "webhook"] }).notNull(),
    name: text("name").notNull(),
    config: text("config", { mode: "json" }).$type<IntegrationConfig>().notNull(),
    events: text("events", { mode: "json" }).$type<IntegrationEventType[]>().notNull().default([]),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastStatus: text("last_status"),
    lastAt: integer("last_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("client_integrations_client_idx").on(t.clientId)],
);
export type ClientIntegration = typeof clientIntegrations.$inferSelect;

/** Кому слать: фильтр по разговорам клиента (тестовые и отписавшиеся исключаются всегда) */
export type CampaignSegment = {
  agentIds?: string[];
  channelTypes?: string[];
  temperature?: ("hot" | "warm" | "cold")[];
  /** Слово в данных карточки клиента или в имени (например, «Riviera») */
  contains?: string;
  /** Последнее сообщение клиента не раньше/не позже N дней назад */
  activeWithinDays?: number;
  inactiveForDays?: number;
  hadHandoff?: boolean;
};
/** Шаг: пауза (для цепочки — от события или прошлого шага), текст или задание ИИ */
export type CampaignStep = { delayHours: number; mode: "text" | "ai"; text: string };
export type CampaignOptions = { quietHours: boolean; optOutHint: boolean };

/**
 * Рассылки и цепочки сообщений: клиент получает сообщение первым. Рассылка — один раз по сегменту (сразу или по
 * расписанию); цепочка — серия шагов по событию (замолчал, передан менеджеру, записался, стал горячим) и
 * останавливается, когда клиент ответил или написал «стоп». Создаются выключенными.
 */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["broadcast", "sequence"] }).notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** С какого момента цепочка набирает участников (события раньше — не в счёт) */
    enabledAt: integer("enabled_at", { mode: "timestamp_ms" }),
    segment: text("segment", { mode: "json" }).$type<CampaignSegment>().notNull().default({}),
    steps: text("steps", { mode: "json" }).$type<CampaignStep[]>().notNull().default([]),
    trigger: text("trigger", { enum: ["idle", "handoff", "booking", "hot"] }),
    scheduleAt: integer("schedule_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: ["draft", "scheduled", "sending", "done", "active", "paused"] }).notNull().default("draft"),
    options: text("options", { mode: "json" }).$type<CampaignOptions>().notNull().default({ quietHours: true, optOutHint: true }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("campaigns_client_idx").on(t.clientId)],
);
export type Campaign = typeof campaigns.$inferSelect;

export const campaignRuns = sqliteTable(
  "campaign_runs",
  {
    id: id(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Номер следующего шага */
    step: integer("step").notNull().default(0),
    status: text("status", { enum: ["pending", "sent", "skipped", "failed", "stopped", "done"] }).notNull().default("pending"),
    dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
    enrolledAt: integer("enrolled_at", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    messageId: text("message_id"),
    error: text("error"),
  },
  (t) => [uniqueIndex("campaign_runs_unique").on(t.campaignId, t.conversationId), index("campaign_runs_due_idx").on(t.status, t.dueAt)],
);
export type CampaignRun = typeof campaignRuns.$inferSelect;

/** Поле анкеты. Для теста: correct — правильный ответ, points — баллы за него */
export type FormField = {
  key: string;
  label: string;
  type: "text" | "choice" | "number" | "phone" | "email" | "rating" | "date";
  options?: string[];
  required: boolean;
  correct?: string;
  points?: number;
};

/**
 * Анкеты, опросы и тесты в диалоге: агент сам проводит клиента по вопросам обычным разговором (в любом канале)
 * и сохраняет ответы инструментом. Для теста (quiz) — правильные ответы и баллы. Заполненная анкета — менеджеру
 * в Telegram и во внешние системы (таблица, вебхук).
 */
export const clientForms = sqliteTable(
  "client_forms",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["form", "quiz"] }).notNull().default("form"),
    name: text("name").notNull(),
    /** Когда предлагать — читает агент */
    purpose: text("purpose").notNull().default(""),
    fields: text("fields", { mode: "json" }).$type<FormField[]>().notNull().default([]),
    /** Что сказать после заполнения */
    thanks: text("thanks").notNull().default(""),
    notify: integer("notify", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("client_forms_client_idx").on(t.clientId)],
);
export type ClientForm = typeof clientForms.$inferSelect;

export const formResponses = sqliteTable(
  "form_responses",
  {
    id: id(),
    formId: text("form_id")
      .notNull()
      .references(() => clientForms.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    answers: text("answers", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    score: integer("score"),
    maxScore: integer("max_score"),
    createdAt: createdAt(),
  },
  (t) => [index("form_responses_form_idx").on(t.formId, t.createdAt)],
);
export type FormResponse = typeof formResponses.$inferSelect;

/** Когда запускать отчёт (время — по Киеву). weekday: 1 — пн … 0 — вс; day: число месяца */
export type RoutineSchedule = { freq: "daily" | "weekly" | "monthly"; hour: number; weekday?: number; day?: number };
/** Откуда брать данные */
export type RoutineSource =
  | { type: "conversations"; days: number; agentIds?: string[] }
  | { type: "sheet"; url: string; sheet: string }
  | { type: "url"; url: string }
  | { type: "search"; query: string }
  | { type: "table"; tableId: string };
/** Куда отправить: сотрудникам студии (бот уведомлений), владельцу бизнеса (подписанные владельцы клиента) */
export type RoutineDelivery = { team: boolean; owners: boolean };

/**
 * Отчёты по расписанию: агент сам собирает данные (разговоры, Google Таблица, страница сайта, поиск в интернете),
 * выполняет задание владельца (KPI, конкуренты, отклонения от бюджета, жалобы…) и присылает отчёт в Telegram.
 */
export const routines = sqliteTable(
  "routines",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    task: text("task").notNull(),
    schedule: text("schedule", { mode: "json" }).$type<RoutineSchedule>().notNull(),
    sources: text("sources", { mode: "json" }).$type<RoutineSource[]>().notNull().default([]),
    delivery: text("delivery", { mode: "json" }).$type<RoutineDelivery>().notNull().default({ team: true, owners: false }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastStatus: text("last_status"),
    lastResult: text("last_result"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("routines_client_idx").on(t.clientId)],
);
export type Routine = typeof routines.$inferSelect;

/** Поле, которое достаём из документа */
export type DocField = { key: string; label: string };

/**
 * Типы документов клиента: что за документ (счёт, договор, резюме, чек…) и какие данные из него достать.
 * Когда клиент присылает файл или фото документа, тип определяется сам, данные извлекаются и сохраняются,
 * уходят менеджеру и во внешние системы (таблица, вебхук).
 */
export const clientDocTypes = sqliteTable(
  "client_doc_types",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Как узнать такой документ — для модели */
    purpose: text("purpose").notNull().default(""),
    fields: text("fields", { mode: "json" }).$type<DocField[]>().notNull().default([]),
    notify: integer("notify", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Папка архива («Договоры», «Счета/2026»); пусто — название типа */
    folder: text("folder").notNull().default(""),
    /** Как назвать файл: «{{date}} Счёт {{supplier}} {{number}}» — поля типа, {{date}} — дата документа или загрузки */
    nameTemplate: text("name_template").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("client_doc_types_client_idx").on(t.clientId)],
);
export type ClientDocType = typeof clientDocTypes.$inferSelect;

export const clientDocuments = sqliteTable(
  "client_documents",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    docTypeId: text("doc_type_id").references(() => clientDocTypes.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    messageId: text("message_id"),
    filename: text("filename").notNull().default(""),
    fields: text("fields", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    /** Коротко: что за документ и главное в нём */
    summary: text("summary").notNull().default(""),
    /** Единое имя по шаблону типа и папка архива */
    title: text("title").notNull().default(""),
    folder: text("folder").notNull().default(""),
    /** Сохранённый файл (загрузка в архив): имя в папке docs рядом с базой */
    file: text("file").notNull().default(""),
    size: integer("size").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("client_documents_client_idx").on(t.clientId, t.createdAt)],
);
export type ClientDocument = typeof clientDocuments.$inferSelect;

/**
 * Шаблоны документов (КП, справка, счёт, договор): текст с {{полями}}. Агент заполняет поля из разговора,
 * документ получает ссылку (страница для печати и сохранения в PDF), агент отправляет её клиенту.
 * Встроенные поля: {{date}} — сегодня, {{number}} — номер документа, {{client}} — имя клиента.
 */
export const docTemplates = sqliteTable(
  "doc_templates",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    body: text("body").notNull().default(""),
    fields: text("fields", { mode: "json" }).$type<DocField[]>().notNull().default([]),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Сколько документов выдано — для {{number}} */
    counter: integer("counter").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("doc_templates_client_idx").on(t.clientId)],
);
export type DocTemplate = typeof docTemplates.$inferSelect;

export type DataColumn = { name: string; type: "number" | "text" | "date" };
/**
 * Таблицы данных клиента для анализа: Google Таблица (обновляется сама) или загруженный CSV / Excel.
 * Агент и «Аналитик» считают по ним точно (фильтры, группировки, суммы) — не на глаз модели.
 */
export const dataTables = sqliteTable(
  "data_tables",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Что в таблице — читает агент */
    description: text("description").notNull().default(""),
    source: text("source", { enum: ["file", "sheet"] }).notNull().default("file"),
    sheetUrl: text("sheet_url").notNull().default(""),
    sheetName: text("sheet_name").notNull().default(""),
    filename: text("filename").notNull().default(""),
    columns: text("columns", { mode: "json" }).$type<DataColumn[]>().notNull().default([]),
    /** Строки без заголовка, значения — как в источнике */
    rows: text("rows", { mode: "json" }).$type<string[][]>().notNull().default([]),
    rowCount: integer("row_count").notNull().default(0),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    refreshedAt: integer("refreshed_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("data_tables_client_idx").on(t.clientId)],
);
export type DataTable = typeof dataTables.$inferSelect;

/**
 * Заявки сотрудников на согласование (отпуск, закупка, скидка, расход): агент для команды оформляет заявку,
 * руководитель решает кнопкой в Telegram или в студии, сотрудник получает ответ в том же чате.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** Номер заявки у клиента по порядку */
    number: integer("number").notNull().default(0),
    requester: text("requester").notNull().default(""),
    subject: text("subject").notNull(),
    details: text("details").notNull().default(""),
    amount: text("amount").notNull().default(""),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
    decidedBy: text("decided_by").notNull().default(""),
    comment: text("comment").notNull().default(""),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_client_idx").on(t.clientId, t.createdAt)],
);
export type Approval = typeof approvals.$inferSelect;

/** Шаг процедуры: вопрос с проверкой ответа, запрос к инструменту, согласование руководителем, сообщение, передача менеджеру. */
export type ProcedureStep =
  | { kind: "ask"; key: string; question: string; type: "text" | "phone" | "email" | "number" | "date" | "choice"; options?: string[] }
  | { kind: "tool"; toolId: string; action?: "find" | "order"; args: Record<string, string>; saveAs: string }
  | { kind: "approval"; subject: string; details: string; amount?: string; rejected: string }
  | { kind: "say"; text: string }
  | { kind: "handoff"; text: string };
/**
 * Процедура с обязательными шагами (возврат, рекламация, оформление заказа…): агент только распознаёт ситуацию и
 * запускает её, дальше программа ведёт клиента по шагам дословно — без пропусков и выдумок.
 */
export const procedures = sqliteTable(
  "procedures",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Когда запускать — читает агент («клиент хочет вернуть товар») */
    trigger: text("trigger").notNull().default(""),
    steps: text("steps", { mode: "json" }).$type<ProcedureStep[]>().notNull().default([]),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("procedures_client_idx").on(t.clientId)],
);
export type Procedure = typeof procedures.$inferSelect;
/** Идущая процедура в разговоре: шаг, собранные ответы, ожидание согласования */
export type ProcedureState = { id: string; step: number; data: Record<string, string>; at: number; waiting?: string; retries?: number };

/**
 * Контент-студия: тексты в стиле бренда (посты, статьи, реклама, SEO-брифы, вакансии), варианты для A/B
 * (одна генерация — один batch), публикация в Telegram-канал клиента сразу или по расписанию.
 */
export const contentItems = sqliteTable(
  "content_items",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    batch: text("batch").notNull().default(""),
    kind: text("kind", { enum: CONTENT_KINDS }).notNull().default("post"),
    platform: text("platform", { enum: CONTENT_PLATFORMS }).notNull().default("telegram"),
    brief: text("brief").notNull().default(""),
    title: text("title").notNull().default(""),
    text: text("text").notNull().default(""),
    /** Картинка к посту: файл в media (c_<случайное>.png), открывается публично по /m/<имя> */
    image: text("image").notNull().default(""),
    imagePrompt: text("image_prompt").notNull().default(""),
    status: text("status", { enum: ["draft", "scheduled", "published", "failed"] }).notNull().default("draft"),
    /** Канал клиента, через который публикуем: бот Telegram (в target — @канал) или аккаунт Threads */
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    /** Куда: @канал или id чата */
    target: text("target").notNull().default(""),
    publishAt: integer("publish_at", { mode: "timestamp_ms" }),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    url: text("url").notNull().default(""),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("content_items_client_idx").on(t.clientId, t.createdAt), index("content_items_due_idx").on(t.status, t.publishAt)],
);
export type ContentItem = typeof contentItems.$inferSelect;

export type MeetingTask = { who: string; what: string; due: string };
export type MeetingDelivery = { team: boolean; owners: boolean; emails?: string[]; channelId?: string; mailStatus?: string };
/**
 * Встречи и звонки: запись (аудио/видео) или готовая расшифровка → протокол, разбор собеседования или
 * звонка продаж; задачи уходят в Telegram и во внешние системы (событие meeting).
 */
export const meetings = sqliteTable(
  "meetings",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    kind: text("kind", { enum: ["protocol", "interview", "sales", "custom"] }).notNull().default("protocol"),
    /** Критерии собеседования, чек-лист звонка или своё задание */
    instructions: text("instructions").notNull().default(""),
    filename: text("filename").notNull().default(""),
    transcript: text("transcript").notNull().default(""),
    summary: text("summary").notNull().default(""),
    /** Разбор в markdown */
    result: text("result").notNull().default(""),
    tasks: text("tasks", { mode: "json" }).$type<MeetingTask[]>().notNull().default([]),
    /** Оценка 1–10 (собеседование, звонок) */
    score: integer("score"),
    status: text("status", { enum: ["processing", "done", "error"] }).notNull().default("processing"),
    error: text("error"),
    /** Кому отправить итоги: студия, владельцы, участники на почту (с почтового канала клиента) */
    delivery: text("delivery", { mode: "json" }).$type<MeetingDelivery>().notNull().default({ team: false, owners: false }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("meetings_client_idx").on(t.clientId, t.createdAt)],
);
export type Meeting = typeof meetings.$inferSelect;

/**
 * Списки контактов (CSV, Excel, Google Таблица): потенциальные клиенты, участники вебинара, база покупателей.
 * По списку — персональная рассылка (outreach): исследование каждого (поиск новостей компании), письмо под него
 * или под его группу, проверка черновиков человеком, отправка с почтового канала клиента или в существующий чат.
 */
export const contactLists = sqliteTable(
  "contact_lists",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    source: text("source").notNull().default("file"),
    createdAt: createdAt(),
  },
  (t) => [index("contact_lists_client_idx").on(t.clientId)],
);
export type ContactList = typeof contactLists.$inferSelect;

export const contacts = sqliteTable(
  "contacts",
  {
    id: id(),
    listId: text("list_id")
      .notNull()
      .references(() => contactLists.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().default(""),
    telegram: text("telegram").notNull().default(""),
    phone: text("phone").notNull().default(""),
    company: text("company").notNull().default(""),
    website: text("website").notNull().default(""),
    /** Группа (сегмент): «активный», «пассивный», «VIP»… — у группы может быть своё задание письма */
    grp: text("grp").notNull().default(""),
    /** Остальные столбцы файла: должность, город, что спрашивал на вебинаре… */
    fields: text("fields", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    unsubscribed: integer("unsubscribed", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("contacts_list_idx").on(t.listId), index("contacts_email_idx").on(t.clientId, t.email)],
);
export type Contact = typeof contacts.$inferSelect;

export const outreach = sqliteTable(
  "outreach",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    listId: text("list_id")
      .notNull()
      .references(() => contactLists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** email — с почтового канала клиента; chats — в существующие разговоры (Telegram, WhatsApp, почта), найденные по контакту */
    mode: text("mode", { enum: ["email", "chats"] }).notNull().default("email"),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    brief: text("brief").notNull().default(""),
    groupBriefs: text("group_briefs", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
    /** Перед письмом найти свежие новости компании контакта (поиск в интернете) */
    research: integer("research", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["draft", "generating", "review", "sending", "done"] }).notNull().default("draft"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("outreach_client_idx").on(t.clientId)],
);
export type Outreach = typeof outreach.$inferSelect;

export const outreachMessages = sqliteTable(
  "outreach_messages",
  {
    id: id(),
    outreachId: text("outreach_id")
      .notNull()
      .references(() => outreach.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    /** Что нашлось о компании (для проверки человеком) */
    research: text("research").notNull().default(""),
    status: text("status", { enum: ["pending", "ready", "approved", "sent", "failed", "skipped"] }).notNull().default("pending"),
    error: text("error"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("outreach_messages_idx").on(t.outreachId, t.status)],
);
export type OutreachMessage = typeof outreachMessages.$inferSelect;

/**
 * Распределение заявок: тема (отдел) → кому из команды приходят уведомления о передаче, горячих клиентах и новых
 * сообщениях. Тему выбирает дешёвая модель по причине и выжимке; не подошла ни одна — всем, как раньше.
 */
export const routingRules = sqliteTable(
  "routing_rules",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Кому: chatId подписчиков бота уведомлений (сотрудники студии и владельцы клиента) */
    chatIds: text("chat_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("routing_rules_client_idx").on(t.clientId)],
);
export type RoutingRule = typeof routingRules.$inferSelect;

export type PriceTier = { from: number; percent: number };
/**
 * Правила цен для расчёта КП: прайс — таблица из «Данных» (столбцы названия и цены), скидки по сумме заказа или
 * количеству (ступени «от … — …%»), НДС, валюта. Считает код: агент только называет позиции и количество.
 */
export const clientPricing = sqliteTable("client_pricing", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  tableId: text("table_id").references(() => dataTables.id, { onDelete: "set null" }),
  nameColumn: text("name_column").notNull().default(""),
  priceColumn: text("price_column").notNull().default(""),
  tierBy: text("tier_by", { enum: ["amount", "qty"] }).notNull().default("amount"),
  tiers: text("tiers", { mode: "json" }).$type<PriceTier[]>().notNull().default([]),
  /** НДС, %: 0 — цены без НДС не пересчитываем */
  vat: real("vat").notNull().default(0),
  currency: text("currency").notNull().default("€"),
  /** Условия, которые агент называет вместе с расчётом (срок действия, предоплата…) */
  notes: text("notes").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ClientPricing = typeof clientPricing.$inferSelect;

export const PAY_PROVIDERS = ["liqpay", "wayforpay", "monobank"] as const;
export type PayProvider = (typeof PAY_PROVIDERS)[number];
/** Ключи эквайринга клиента: LiqPay — publicKey/privateKey, WayForPay — merchant/secret/domain, Monobank — token. */
export type PayCredentials = { publicKey?: string; privateKey?: string; merchant?: string; secret?: string; domain?: string; token?: string };
/** Приём оплат в диалоге: агент выдаёт ссылку на оплату, банк сообщает о результате. */
export const clientPayments = sqliteTable("client_payments", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: PAY_PROVIDERS }).notNull(),
  credentials: text("credentials", { mode: "json" }).$type<PayCredentials>().notNull().default({}),
  currency: text("currency").notNull().default("UAH"),
  /** Больше этой суммы агент ссылку не выдаёт (передаёт менеджеру); null — без ограничения */
  maxAmount: real("max_amount"),
  /** Сообщение клиенту после оплаты; пусто — стандартное */
  paidText: text("paid_text").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ClientPayments = typeof clientPayments.$inferSelect;

/**
 * Биллинг клиента студии: абонплата, наценка на расходы ИИ по ключам студии и на сообщения WhatsApp, включённый
 * в абонплату объём, курс к валюте счёта, месячный лимит расходов (достигнут — агенты клиента молчат, команде сигнал).
 */
export const clientBilling = sqliteTable("client_billing", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("USD"),
  /** Курс: сколько единиц валюты счёта за 1 USD */
  usdRate: real("usd_rate").notNull().default(1),
  /** Абонплата в месяц, в валюте счёта */
  fee: real("fee").notNull().default(0),
  /** Наценка на расходы ИИ по ключам студии, % */
  markupPct: real("markup_pct").notNull().default(0),
  /** Наценка на сообщения каналов (WhatsApp), % */
  channelMarkupPct: real("channel_markup_pct").notNull().default(0),
  /** Расходы ИИ, включённые в абонплату, USD (сверх — по наценке) */
  includedUsd: real("included_usd").notNull().default(0),
  /** Лимит себестоимости в месяц, USD; null — без лимита */
  limitUsd: real("limit_usd"),
  /** Когда предупредили о 80% / 100% лимита (YYYY-MM:pct) */
  alerted: text("alerted").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ClientBilling = typeof clientBilling.$inferSelect;

/** Ключи открытого API студии (/api/v1): хранится только хэш; права read или write; можно ограничить клиентами. */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    name: text("name").notNull(),
    /** Начало ключа для узнавания в списке (ga_live_ab12…) */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scope: text("scope", { enum: ["read", "write"] }).notNull().default("read"),
    /** Только эти клиенты; null — все */
    clientIds: text("client_ids", { mode: "json" }).$type<string[] | null>(),
    createdBy: text("created_by"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);
export type ApiKey = typeof apiKeys.$inferSelect;

export const PAYMENT_STATUSES = ["created", "paid", "failed", "expired", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const payments = sqliteTable(
  "payments",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    agentId: text("agent_id"),
    provider: text("provider", { enum: PAY_PROVIDERS }).notNull(),
    /** Номер заказа у банка (наш) */
    orderId: text("order_id").notNull(),
    /** Номер счёта у банка (Monobank invoiceId) */
    externalId: text("external_id"),
    amount: real("amount").notNull(),
    currency: text("currency").notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: PAYMENT_STATUSES }).notNull().default("created"),
    url: text("url").notNull(),
    createdAt: createdAt(),
    paidAt: integer("paid_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("payments_order_idx").on(t.orderId), index("payments_client_idx").on(t.clientId, t.createdAt), index("payments_conv_idx").on(t.conversationId)],
);
export type Payment = typeof payments.$inferSelect;

export type ReminderKind = "date" | "status";
/**
 * Напоминания по таблице из «Данных»: по дате (оплата, доставка, продление — за N дней) или при смене статуса
 * (заказ «отправлен», «доставлен»). Человек находится по контакту в строке (чат по @нику / телефону / почте или
 * письмо с почтового канала); текст — шаблон со {{Столбцами}}. Одно напоминание на строку и дату / статус.
 */
export const reminders = sqliteTable(
  "reminders",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tableId: text("table_id").references(() => dataTables.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["date", "status"] }).notNull().default("date"),
    dateColumn: text("date_column").notNull().default(""),
    /** За сколько дней до даты (0 — в день, отрицательное — через N дней после) */
    offsetDays: integer("offset_days").notNull().default(1),
    /** Столбец-ключ строки (номер заказа / счёта); пусто — контакт */
    keyColumn: text("key_column").notNull().default(""),
    statusColumn: text("status_column").notNull().default(""),
    /** Для даты — только строки с таким статусом («не оплачен»); для статуса — о каких значениях сообщать (пусто — о любом) */
    statusValues: text("status_values", { mode: "json" }).$type<string[]>().notNull().default([]),
    contactColumn: text("contact_column").notNull().default(""),
    /** Почтовый канал для контактов-почт без чата */
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    message: text("message").notNull().default(""),
    hour: integer("hour").notNull().default(10),
    notifyTeam: integer("notify_team", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastResult: text("last_result"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("reminders_client_idx").on(t.clientId)],
);
export type Reminder = typeof reminders.$inferSelect;

export const reminderLog = sqliteTable(
  "reminder_log",
  {
    id: id(),
    reminderId: text("reminder_id")
      .notNull()
      .references(() => reminders.id, { onDelete: "cascade" }),
    rowKey: text("row_key").notNull(),
    /** Дата (для напоминаний по дате) или значение статуса */
    value: text("value").notNull(),
    /** sent — отправлено; seen — исходный статус (без сообщения); no_chat, failed */
    status: text("status").notNull(),
    contact: text("contact").notNull().default(""),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reminder_log_unique").on(t.reminderId, t.rowKey, t.value)],
);

export type OnboardingStep = { title: string; day: number; kind: "task" | "meet" | "read"; owner: string };
export type OnboardingItem = { id: string; title: string; due: string; kind: OnboardingStep["kind"]; owner: string; done: boolean; doneAt?: string };
/**
 * Адаптация новых сотрудников: шаблон плана (шаги по дням от выхода: задачи, знакомства, что прочитать) →
 * персональный чек-лист новичка (ИИ дополняет под должность), приветственное письмо, ежедневные напоминания
 * новичку и команде, отметки «сделано» в чате с агентом команды или в студии.
 */
export const onboardingPlans = sqliteTable(
  "onboarding_plans",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    steps: text("steps", { mode: "json" }).$type<OnboardingStep[]>().notNull().default([]),
    /** О чём приветственное письмо: тон, что взять в первый день, к кому обращаться */
    welcome: text("welcome").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("onboarding_plans_client_idx").on(t.clientId)],
);
export type OnboardingPlan = typeof onboardingPlans.$inferSelect;

export const onboardings = sqliteTable(
  "onboardings",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    planId: text("plan_id").references(() => onboardingPlans.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    /** @ник Telegram или телефон — чат с агентом команды */
    contact: text("contact").notNull().default(""),
    email: text("email").notNull().default(""),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    /** Первый рабочий день, ГГГГ-ММ-ДД */
    startDate: text("start_date").notNull(),
    items: text("items", { mode: "json" }).$type<OnboardingItem[]>().notNull().default([]),
    welcomeText: text("welcome_text").notNull().default(""),
    /** pending — ещё не отправлено; sent; no_contact — нет ни чата, ни почты */
    welcomeStatus: text("welcome_status").notNull().default("pending"),
    /** День последней рассылки напоминаний (ГГГГ-ММ-ДД) */
    lastTick: text("last_tick").notNull().default(""),
    status: text("status", { enum: ["active", "done"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("onboardings_client_idx").on(t.clientId, t.status)],
);
export type Onboarding = typeof onboardings.$inferSelect;

/** Подбор: вакансия (требования) и кандидаты — резюме оцениваются по требованиям, список сортируется по баллу. */
export const vacancies = sqliteTable(
  "vacancies",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    requirements: text("requirements").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("vacancies_client_idx").on(t.clientId)],
);
export type Vacancy = typeof vacancies.$inferSelect;

export const candidates = sqliteTable(
  "candidates",
  {
    id: id(),
    vacancyId: text("vacancy_id")
      .notNull()
      .references(() => vacancies.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    name: text("name").notNull().default(""),
    contact: text("contact").notNull().default(""),
    filename: text("filename").notNull().default(""),
    /** Текст резюме */
    text: text("text").notNull().default(""),
    /** 0–100: соответствие требованиям */
    score: integer("score"),
    verdict: text("verdict", { enum: ["strong", "maybe", "no"] }),
    summary: text("summary").notNull().default(""),
    strengths: text("strengths", { mode: "json" }).$type<string[]>().notNull().default([]),
    gaps: text("gaps", { mode: "json" }).$type<string[]>().notNull().default([]),
    status: text("status", { enum: ["processing", "done", "error"] }).notNull().default("processing"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("candidates_vacancy_idx").on(t.vacancyId)],
);
export type Candidate = typeof candidates.$inferSelect;

/**
 * Повторные покупки: по таблице заказов (клиент, дата, контакт, товар, сумма) — у кого обычно какой интервал
 * между покупками, когда ждать следующую и насколько вероятно; вовремя — личное напоминание или предложение.
 */
export const clientRepeat = sqliteTable("client_repeat", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  tableId: text("table_id").references(() => dataTables.id, { onDelete: "set null" }),
  customerColumn: text("customer_column").notNull().default(""),
  dateColumn: text("date_column").notNull().default(""),
  contactColumn: text("contact_column").notNull().default(""),
  productColumn: text("product_column").notNull().default(""),
  amountColumn: text("amount_column").notNull().default(""),
  /** За сколько дней до ожидаемой покупки напоминать */
  leadDays: integer("lead_days").notNull().default(3),
  /** С какого числа заказов клиент считается «повторным» */
  minOrders: integer("min_orders").notNull().default(2),
  /** Отправлять напоминания самим (раз в день) */
  auto: integer("auto", { mode: "boolean" }).notNull().default(false),
  /** Что предложить: «скидка 5% на повторный заказ», «напомнить пополнить запас» */
  brief: text("brief").notNull().default(""),
  channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
  hour: integer("hour").notNull().default(11),
  lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
  lastResult: text("last_result"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ClientRepeat = typeof clientRepeat.$inferSelect;

export const repeatNudges = sqliteTable(
  "repeat_nudges",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    customer: text("customer").notNull(),
    /** Дата последнего заказа на момент напоминания: одно напоминание на «цикл» */
    lastOrder: text("last_order").notNull(),
    message: text("message").notNull().default(""),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("repeat_nudges_unique").on(t.clientId, t.customer, t.lastOrder)],
);

export type TripStop = {
  name: string;
  address: string;
  kg: number;
  m3: number;
  /** Контакт получателя: @ник, телефон или почта — ему сообщения «едем», «задержка», «доставлено» */
  contact: string;
  /** Плановое время прибытия (мс) */
  eta: number;
  /** Прогноз сейчас (мс) — с пробками, погодой и историей */
  forecast?: number;
  status: "pending" | "done" | "failed";
  doneAt?: number;
  note?: string;
  /** Что уже сообщили получателю: on_way — едем к вам, delay — задержка (минут), done */
  told?: { onWay?: boolean; delayMin?: number; done?: boolean };
};
/**
 * Рейсы: сохранённый маршрут с водителем. Водитель получает маршрут в мессенджере и отмечает точки в чате с агентом;
 * получатели — «едем к вам», «задержка до …», «доставлено»; прогноз задержек — пробки (Google), погода (Open-Meteo)
 * и история прошлых рейсов.
 */
export const trips = sqliteTable(
  "trips",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    vehicle: text("vehicle").notNull().default(""),
    /** @ник Telegram или телефон водителя */
    driver: text("driver").notNull().default(""),
    driverName: text("driver_name").notNull().default(""),
    departure: integer("departure", { mode: "timestamp_ms" }).notNull(),
    returnToBase: integer("return_to_base", { mode: "boolean" }).notNull().default(true),
    stops: text("stops", { mode: "json" }).$type<TripStop[]>().notNull().default([]),
    km: real("km").notNull().default(0),
    minutes: integer("minutes").notNull().default(0),
    mapsUrl: text("maps_url").notNull().default(""),
    /** Инструкции водителю: где забрать, кому звонить, оплата на месте */
    instructions: text("instructions").notNull().default(""),
    notifyCustomers: integer("notify_customers", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ["planned", "sent", "active", "done"] }).notNull().default("planned"),
    /** Риск задержки: погода и история — текстом для студии */
    risk: text("risk").notNull().default(""),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    lastCheckAt: integer("last_check_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("trips_client_idx").on(t.clientId, t.status)],
);
export type Trip = typeof trips.$inferSelect;

/**
 * Контроль сервисов клиента: проверка сайта / API (ответ, текст на странице, время ответа) или сигналы из его
 * систем (вебхук с ошибками и метриками). Сбой подряд N раз — инцидент: сообщение команде и черновик
 * упреждающего сообщения клиентам, которых это заденет (из него — рассылка после проверки человеком).
 */
export const monitors = sqliteTable(
  "monitors",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["http", "webhook"] }).notNull().default("http"),
    url: text("url").notNull().default(""),
    /** Текст, который должен быть в ответе (например, "ok" или название на странице) */
    expectText: text("expect_text").notNull().default(""),
    /** Медленнее — тоже сбой */
    maxMs: integer("max_ms").notNull().default(10000),
    intervalMin: integer("interval_min").notNull().default(5),
    failThreshold: integer("fail_threshold").notNull().default(2),
    /** Ключ для сигналов из систем клиента: POST /api/monitor/<id> */
    apiKey: text("api_key").notNull(),
    /** Кого заденет сбой — для черновика сообщения: «все, кто платит онлайн», «пользователи приложения» */
    audience: text("audience").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ["unknown", "up", "down"] }).notNull().default("unknown"),
    fails: integer("fails").notNull().default(0),
    lastCheckAt: integer("last_check_at", { mode: "timestamp_ms" }),
    lastMs: integer("last_ms"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("monitors_client_idx").on(t.clientId)],
);
export type Monitor = typeof monitors.$inferSelect;

export const incidents = sqliteTable(
  "incidents",
  {
    id: id(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    error: text("error").notNull().default(""),
    /** Черновик упреждающего сообщения клиентам (проверяет человек) */
    draft: text("draft").notNull().default(""),
    /** Черновик «всё снова работает» */
    resolvedDraft: text("resolved_draft").notNull().default(""),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    /** Рассылка, созданная из черновика */
    campaignId: text("campaign_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("incidents_monitor_idx").on(t.monitorId, t.startedAt)],
);
export type Incident = typeof incidents.$inferSelect;

export type QuizQuestion = { q: string; options: string[]; correct: number };
/**
 * Обучение в мессенджере: курсы из уроков (текст, видео, тест), баллы за уроки и курс (в программу баллов клиента),
 * личная программа по уровню, цели и результатам тестов, напоминания продолжить. Учится клиент или сотрудник
 * прямо в чате с агентом.
 */
export const courses = sqliteTable(
  "courses",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    level: text("level", { enum: ["beginner", "intermediate", "advanced"] }).notNull().default("beginner"),
    /** Темы через запятую — для подбора программы под цель */
    topics: text("topics").notNull().default(""),
    /** Бонус за весь курс */
    points: integer("points").notNull().default(0),
    /** Куда начислять баллы (программа баллов клиента) */
    programId: text("program_id").references(() => loyaltyPrograms.id, { onDelete: "set null" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("courses_client_idx").on(t.clientId)],
);
export type Course = typeof courses.$inferSelect;

export const lessons = sqliteTable(
  "lessons",
  {
    id: id(),
    courseId: text("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    videoUrl: text("video_url").notNull().default(""),
    quiz: text("quiz", { mode: "json" }).$type<QuizQuestion[]>().notNull().default([]),
    /** Сколько % правильных — урок сдан */
    passScore: integer("pass_score").notNull().default(70),
    points: integer("points").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("lessons_course_idx").on(t.courseId, t.position)],
);
export type Lesson = typeof lessons.$inferSelect;

export type LessonResult = { score: number; passed: boolean; at: number; tries: number };
export const learners = sqliteTable(
  "learners",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** Нормализованный контакт: ник, телефон, почта или id чата */
    contact: text("contact").notNull(),
    name: text("name").notNull().default(""),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    level: text("level").notNull().default(""),
    goal: text("goal").notNull().default(""),
    /** Личная программа: курсы по порядку */
    path: text("path", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** Результаты по урокам: lessonId → оценка */
    results: text("results", { mode: "json" }).$type<Record<string, LessonResult>>().notNull().default({}),
    points: integer("points").notNull().default(0),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
    remindedAt: integer("reminded_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("learners_contact_idx").on(t.clientId, t.contact)],
);
export type Learner = typeof learners.$inferSelect;

export type Vehicle = { name: string; capacityKg: number; capacityM3: number };
/** Логистика клиента: склад / точка отправления, время на одну точку, машины; правила доставки — для агента. */
export const clientLogistics = sqliteTable("client_logistics", {
  clientId: text("client_id")
    .primaryKey()
    .references(() => clients.id, { onDelete: "cascade" }),
  baseAddress: text("base_address").notNull().default(""),
  stopMinutes: integer("stop_minutes").notNull().default(10),
  vehicles: text("vehicles", { mode: "json" }).$type<Vehicle[]>().notNull().default([]),
  /** Стоимость и условия доставки — агент называет их вместе с расчётом расстояния */
  deliveryNote: text("delivery_note").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
export type ClientLogistics = typeof clientLogistics.$inferSelect;

export type LoyaltyReward = { name: string; cost: number };
/**
 * Баллы и лояльность: программа клиента (правила, награды, приветственный бонус), счета клиентов или сотрудников
 * (по контакту: @ник, id Telegram, телефон, почта) и история начислений и списаний.
 */
export const loyaltyPrograms = sqliteTable(
  "loyalty_programs",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Бонусы"),
    /** Как называть баллы в родительном падеже: «баллов», «бонусов», «звёзд» */
    unit: text("unit").notNull().default("баллов"),
    /** Как начисляются — читает агент */
    rules: text("rules").notNull().default(""),
    rewards: text("rewards", { mode: "json" }).$type<LoyaltyReward[]>().notNull().default([]),
    welcome: integer("welcome").notNull().default(0),
    /** Благодарности коллегам: сколько баллов в месяц каждый может подарить другим (0 — выключено) */
    peerAllowance: integer("peer_allowance").notNull().default(0),
    /** Сообщать клиенту в чат о начислениях из студии и API */
    notifyCustomer: integer("notify_customer", { mode: "boolean" }).notNull().default(true),
    /** Ключ для начислений из CRM / сайта (POST /api/loyalty/<id>) */
    apiKey: text("api_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("loyalty_programs_client_idx").on(t.clientId)],
);
export type LoyaltyProgram = typeof loyaltyPrograms.$inferSelect;

export const loyaltyAccounts = sqliteTable(
  "loyalty_accounts",
  {
    id: id(),
    programId: text("program_id")
      .notNull()
      .references(() => loyaltyPrograms.id, { onDelete: "cascade" }),
    /** Нормализованный контакт: телефон цифрами, ник без @ строчными, id Telegram, почта */
    contact: text("contact").notNull(),
    name: text("name").notNull().default(""),
    /** Последний разговор — туда приходят сообщения о начислениях */
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    balance: integer("balance").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("loyalty_accounts_contact_idx").on(t.programId, t.contact)],
);
export type LoyaltyAccount = typeof loyaltyAccounts.$inferSelect;

export const loyaltyTx = sqliteTable(
  "loyalty_tx",
  {
    id: id(),
    accountId: text("account_id")
      .notNull()
      .references(() => loyaltyAccounts.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    /** Баланс после операции */
    balance: integer("balance").notNull(),
    reason: text("reason").notNull().default(""),
    source: text("source", { enum: ["studio", "api", "agent", "welcome", "peer"] }).notNull().default("studio"),
    /** Кто подарил (благодарность коллеге) — счёт дарителя */
    giverId: text("giver_id"),
    createdAt: createdAt(),
  },
  (t) => [index("loyalty_tx_account_idx").on(t.accountId, t.createdAt)],
);

/** Выданный документ: id — неугадываемая ссылка /d/<id> */
export const generatedDocs = sqliteTable(
  "generated_docs",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id").references(() => docTemplates.id, { onDelete: "set null" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("generated_docs_client_idx").on(t.clientId, t.createdAt)],
);
export type GeneratedDoc = typeof generatedDocs.$inferSelect;

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
  /** Кнопки-подсказки до первого сообщения («Подобрать виллу», «Записаться на просмотр») */
  quick?: string[];
  /** Приглашение к разговору: облачко у кнопки чата через teaserDelay секунд (пусто — не показывать) */
  teaser?: string;
  teaserDelay?: number;
  /** Тексты на языке посетителя (сайт на нескольких языках): заголовок, подзаголовок, приветствие, подсказки */
  locales?: Partial<Record<WidgetLang, WidgetLocale>>;
  /** Голосовой ввод: кнопка микрофона, речь → текст на сервере; ответ на голос браузер читает вслух */
  voice?: boolean;
};
export const WIDGET_LANGS = ["ru", "uk", "en", "es"] as const;
export type WidgetLang = (typeof WIDGET_LANGS)[number];
export type WidgetLocale = { title?: string; subtitle?: string; greeting?: string; quick?: string[]; teaser?: string };
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
  /** Кодовые слова в комментариях → личное сообщение автору (и короткий публичный ответ под комментарием) */
  triggers?: IgTrigger[];
};
/** «Напишите ПРАЙС в комментариях»: слово → сообщение в директ; postId — только под этим постом (пусто — под любым). */
export type IgTrigger = { keyword: string; dm: string; reply: string; postId?: string };
/** Откуда пришёл клиент: реклама (Instagram, WhatsApp), ответ на историю, кодовое слово в комментарии, ссылка с меткой */
export type ConversationSource = { kind: "ad" | "story" | "comment" | "link"; title?: string; ref?: string; url?: string; at: number };
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
  /** Под ответами бот показывает 👍/👎: агент один раз за разговор, в конце, просит оценить */
  ratingInvite?: boolean;
};
/** WhatsApp Business (Cloud API): ID номера и постоянный токен системного пользователя Meta. */
export type WhatsAppConfig = {
  phoneNumberId: string;
  /** Номер, как его видят клиенты: +34 600 000 000 */
  displayPhone: string;
  /** Подтверждённое имя компании в WhatsApp */
  verifiedName?: string;
  token: string;
  /** ID бизнес-аккаунта WhatsApp (WABA) — чтобы загрузить утверждённые шаблоны */
  wabaId?: string;
  /** Утверждённые шаблоны (загружаются из Meta): body — текст с {{1}}, {{2}}… */
  templates?: WaTemplate[];
  /** Шаблон для сообщений вне 24-часового окна (напоминания, рассылки): наш текст подставляется в {{1}} */
  proactiveTemplate?: { name: string; language: string };
  /** Цена сообщения для учёта расходов клиента, USD: обычный ответ и шаблон */
  price?: { service: number; template: number };
};
export type WaTemplate = { name: string; language: string; category: string; body: string; params: number };
/** Viber: бот (Viber Bot API) — токен из кабинета партнёра; вебхук регистрируется при подключении. */
export type ViberConfig = {
  token: string;
  /** Имя и аватар отправителя в сообщениях бота */
  botName: string;
  avatar?: string;
  /** Адрес бота: viber://pa?chatURI=… */
  uri?: string;
  /** Приветствие при открытии чата (событие conversation_started) */
  welcome?: string;
};
/**
 * Голос (телефон): агент как «своя модель» для голосовых платформ (Vapi, ElevenLabs) — они распознают речь, звонят
 * и говорят, а ответы берут у агента по адресу /api/agent/{id}/chat/completions (формат OpenAI) с ключом канала.
 */
export type VoiceConfig = { key: string; provider: "vapi" | "elevenlabs" | "other"; /** Номер, на который звонят клиенты (для людей) */ phone?: string };
/** Facebook Messenger: страница компании (id, название) и её токен из Meta Business. */
export type MessengerConfig = { pageId: string; pageName: string; token: string };
/** SMS через Twilio: аккаунт, токен, номер-отправитель. */
export type SmsChannelConfig = { accountSid: string; authToken: string; from: string };
export type ChannelConfig = TelegramConfig | WidgetConfig | InstagramConfig | ThreadsConfig | EmailConfig | ApiConfig | WhatsAppConfig | ViberConfig | VoiceConfig | MessengerConfig | SmsChannelConfig;
export const CHANNEL_TYPES = ["telegram", "widget", "instagram", "threads", "email", "api", "whatsapp", "viber", "voice", "messenger", "sms"] as const;
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
    /** Тестовый разговор (свой или сотрудника): не в аналитике, памяти, обучении и проверках */
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
    unread: integer("unread").notNull().default(0),
    /** Сотрудник студии, ответственный за разговор (null — никто не взял) */
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** Метки команды: «VIP», «жалоба», свои — для фильтра в «Диалогах» */
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** «Отложить до…»: разговор скрыт из списка до этого времени или до нового сообщения клиента после snoozedAt */
    snoozedUntil: integer("snoozed_until", { mode: "timestamp_ms" }),
    snoozedAt: integer("snoozed_at", { mode: "timestamp_ms" }),
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

/** Внутренние заметки команды к разговору: клиент их не видит; mentions — id упомянутых сотрудников (@имя). */
export const conversationNotes = sqliteTable(
  "conversation_notes",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull().default(""),
    text: text("text").notNull(),
    mentions: text("mentions", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("conversation_notes_conv_idx").on(t.conversationId, t.createdAt)],
);

/** Долгая память о клиенте: короткие факты из прошлых разговоров (src/lib/agent/memory.ts) */
export type ClientMemory = {
  facts: string[];
  /** Когда обновляли */
  at: number;
  /** До какого сообщения (время, мс) переписка уже учтена */
  upto: number;
};

/** Свой бот: расписание команды на момент вопроса клиента (для честного срока ответа менеджера) */
export type TeamState = {
  open: boolean;
  /** Когда откроются, словами на языке клиента: «завтра з 10:00» */
  next?: string;
  /** Обычно отвечают за столько минут */
  minutes?: number;
  at: number;
};

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

/** Карточка лида: поля со слов клиента и «горячесть» (hot — готов к шагу, warm — конкретный интерес, cold — общий вопрос). */
export type LeadCard = {
  temperature: "hot" | "warm" | "cold";
  reason: string;
  fields: { label: string; value: string }[];
  /** Похоже на проверку бота, а не на клиента — в «Диалогах» подсказка пометить разговор тестовым */
  looksTest?: boolean;
  at: number;
  /** До какого сообщения переписка учтена (мс) */
  upto: number;
};

export type ConversationContext = {
  /** Клиент написал «стоп» — рассылки и цепочки ему не отправляются */
  optOut?: boolean;
  /** Агент для сотрудников: этому собеседнику уже ответили, что доступа нет */
  teamDenied?: boolean;
  /** Ответственные за разговор по распределению заявок: тема и кому уходят уведомления */
  assignedTo?: { rule: string; chatIds: string[]; at: number };
  /** Строка заявки этого разговора в Google Таблице (id интеграции → номер строки) */
  sheetRows?: Record<string, number>;
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
  /** Что агент помнит о клиенте из прошлых разговоров */
  memory?: ClientMemory;
  /** Карточка лида: что клиент хочет и насколько готов к шагу (lib/agent/lead.ts) */
  lead?: LeadCard;
  /** Когда агент попросил оценить ответ (один раз за разговор) */
  ratingAskedAt?: number;
  /** Оповещение «горячий клиент в чате»: когда отправлено; pending — стал горячим ночью, отправим в рабочие часы */
  hotAlertAt?: number;
  hotAlertPending?: boolean;
  /** Свой бот: открыта ли сейчас команда и как быстро отвечает */
  team?: TeamState;
  /** Черновик ответа менеджеру, который агент подготовил при передаче (в Telegram — «Отправить черновик») */
  managerDraft?: { text: string; at: number };
  /** Свой бот (API): язык, на котором отвечать клиенту, и что клиент сейчас смотрит в боте */
  language?: string;
  /** Когда агент сообщил, что он ИИ (первый ответ) */
  aiDisclosedAt?: number;
  botContext?: string;
  /** Виджет: одноразовый код ссылки «Продолжить в Telegram» и когда выдан */
  linkToken?: string;
  linkAt?: number;
  /** Разговор продолжен в боте (id разговора там) / пришёл с сайта (id разговора виджета) */
  linkedTo?: string;
  linkedFrom?: string;
  /** A/B-проверка версий агента: в каком варианте разговор («A» или «B:{id версии}») */
  variant?: string;
  /** Процедура с обязательными шагами, которая сейчас идёт в разговоре */
  procedure?: ProcedureState;
  /** Лиды, созданные в CRM из этого разговора: id подключения → id в CRM */
  crmLeads?: Record<string, string>;
  /** Откуда пришёл клиент (реклама, история, комментарий, ссылка с меткой) — агент учитывает, аналитика считает */
  source?: ConversationSource;
};

export type MessageMeta = {
  /** Документ от клиента: имя файла и извлечённый текст (агент его читает) */
  document?: { name: string; text: string };
  /** Сообщение рассылки или цепочки: какая и какой шаг */
  campaign?: { id: string; name: string; step: number };
  /** Оценка ответа сотрудника (контроль качества): 1–10, замечания, улучшенный вариант */
  operatorReview?: { score: number; problems: string[]; better: string };
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
  /** Передача менеджеру: почему (метка [[ACTION reason: …]]) */
  reason?: string;
  /** Передача менеджеру: сколько раз агент передавал повторно, пока менеджер не ответил (без новых уведомлений) */
  repeats?: number;
  /** Инструменты, вызванные агентом при ответе (например, запись в календарь) */
  tools?: { name: string; error?: boolean }[];
  /** Действия для своего бота из меток [[ACTION тип: значение]] — например, проверить препарат в аптеке */
  actions?: { type: string; value: string }[];
  /** Напоминание агента клиенту, который ушёл ни с чем */
  followUp?: boolean;
  /** Сообщение агента о смене статуса заказа (бот отправил его вместо шаблона) */
  orderNote?: boolean;
  /** Ответ агента ушёл и голосовым */
  spoken?: boolean;
  /** Сообщение написала процедура с обязательными шагами (не модель) */
  procedure?: boolean;
  /** Кнопки быстрых ответов под сообщением (Telegram, Viber) */
  buttons?: string[];
  /** Трассировка ответа: вызовы инструментов (вход и результат, коротко), вариант A/B */
  trace?: { steps: { tool: string; input: string; result: string; error?: boolean }[]; variant?: string };
  /** Агент дословно пересказывал служебные инструкции — ответ заменён отказом */
  leakBlocked?: boolean;
  /** Утренняя проверка качества: замечание к ответу (или ok — проверен, в порядке) */
  qa?: { ok?: boolean; severity?: "low" | "high"; kind?: string; note?: string; better?: string; at: number };
  /** Проверяемые факты ответа (цены, телефоны, ссылки), которых нет в базе знаний и переписке */
  unverified?: string[];
  /** Проверка ответа перед отправкой: что нашла и переписан ли ответ */
  check?: { ok: boolean; problems: string[]; rewritten?: boolean; ms?: number; rewriteMs?: number; skipped?: boolean };
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
    /** Вызов шёл по ключу клиента (за его счёт) */
    ownKey: integer("own_key", { mode: "boolean" }).notNull().default(false),
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
    /** Сравнение моделей: прогон на другой модели (агент не меняется). null — модель агента */
    model: text("model"),
    /** pass^k: сколько раз прогонялся каждый сценарий (пройден — только если прошёл все k раз) */
    k: integer("k").notNull().default(1),
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
