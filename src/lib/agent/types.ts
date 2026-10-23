import { z } from "zod";

export const TONES = ["friendly", "formal", "expert", "playful", "custom"] as const;
export const REPLY_LANGUAGES = ["auto", "ru", "uk", "en"] as const;
export const EFFORTS = ["low", "medium", "high"] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Онлайн-запись в Google Календарь клиента. */
export const calendarConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** ID календаря (обычно email владельца) — к нему открыт доступ для сервисного аккаунта студии */
  calendarId: z.string().trim().max(300).default(""),
  timezone: z
    .string()
    .max(60)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "invalid_timezone")
    .default("Europe/Kyiv"),
  /** Рабочие дни: 0 — воскресенье … 6 — суббота */
  workDays: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
  workStart: time.default("09:00"),
  workEnd: time.default("18:00"),
  /** Длительность записи по умолчанию, минуты */
  slotMinutes: z.number().int().min(10).max(480).default(60),
  services: z
    .array(z.object({ name: z.string().trim().max(100), minutes: z.number().int().min(10).max(480) }))
    .max(30)
    .default([])
    // Пустые строки, оставленные в конструкторе, не сохраняем.
    .transform((list) => list.filter((s) => s.name)),
  /** Не раньше чем через N часов от текущего момента */
  minNoticeHours: z.number().min(0).max(168).default(2),
  /** Не дальше чем на N дней вперёд */
  horizonDays: z.number().int().min(1).max(180).default(30),
});

export type CalendarConfig = z.infer<typeof calendarConfigSchema>;

export const agentConfigSchema = z.object({
  icon: z.string().max(8).default("🤖"),
  role: z.string().max(300).default(""),
  description: z.string().max(4000).default(""),
  model: z.string().min(1),
  effort: z.enum(EFFORTS).default("low"),
  tone: z.enum(TONES).default("friendly"),
  toneCustom: z.string().max(1000).default(""),
  replyLanguage: z.enum(REPLY_LANGUAGES).default("auto"),
  skills: z.array(z.string()).default([]),
  knowledge: z.string().max(50000).default(""),
  /** Источники базы знаний клиента, которыми пользуется агент; null — все. */
  kbSourceIds: z.array(z.string()).nullable().default(null),
  /** Свои инструменты клиента (client_tools), которые может вызывать агент */
  toolIds: z.array(z.string()).max(30).optional(),
  /** Поиск в интернете (если включён в «Внешних сервисах») */
  webSearch: z.boolean().optional(),
  /** Анкеты и тесты клиента (client_forms), которые проводит агент */
  formIds: z.array(z.string()).max(20).optional(),
  /** Шаблоны документов (КП, справки…), которые агент может выдать клиенту */
  docTemplateIds: z.array(z.string()).max(20).optional(),
  /** Таблицы данных клиента (data_tables), по которым агент считает точно */
  tableIds: z.array(z.string()).max(20).optional(),
  /** Агент для сотрудников: отвечает только людям из списка, может оформлять заявки на согласование */
  team: z
    .object({
      enabled: z.boolean(),
      /** По одному в строке: @username, id Telegram, телефон, почта; «*» — все */
      allowed: z.string().max(5000),
      denyText: z.string().max(500),
      approvals: z.boolean(),
      /** Кто решает: владельцы бизнеса (подписанные в боте уведомлений), сотрудники студии или все */
      approvers: z.enum(["owners", "team", "both"]),
    })
    .optional(),
  rules: z.string().max(5000).default(""),
  handoff: z.string().max(2000).default(""),
  /** Поля карточки лида через запятую (пусто — общие: что ищет, бюджет, сроки, контакт) */
  leadFields: z.string().max(400).optional(),
  greeting: z.string().max(1000).default(""),
  extraInstructions: z.string().max(10000).default(""),
  useBrandVoice: z.boolean().default(true),
  /**
   * Проверка ответов на выдуманные факты (цены, телефоны, ссылки, которых нет в базе знаний):
   * flag — помечать (в «Диалогах» и разборе недели), block — не отправлять, а на одобрение / сотруднику, off — не проверять.
   */
  factGuard: z.enum(["off", "flag", "block"]).default("flag"),
  /** Лимит расходов агента в месяц, USD; null — без лимита. */
  monthlyBudgetUsd: z.number().min(0).max(100000).nullable().default(null),
  /** Долгая память о клиенте: агент помнит факты из прошлых разговоров (раз в 10 минут дешёвая модель их обновляет) */
  memory: z.boolean().default(true),
  /** Голосовые ответы: клиент прислал голосовое — агент отвечает голосовым (OpenAI TTS, нужен OPENAI_API_KEY) */
  voiceReplies: z.boolean().default(true),
  /** Голос озвучки (marin, cedar, coral, nova…) */
  voice: z.string().max(20).default("marin"),
  /** Утренняя проверка качества ответов (более сильная модель, раз в сутки) */
  qualityCheck: z.boolean().default(true),
  /** Проверка ответа перед отправкой (вторая модель; при проблеме — один раз переписать) */
  answerCheck: z.boolean().optional(),
  /** Контроль качества ответов сотрудников (оценка после отправки) */
  operatorReview: z.boolean().optional(),
  calendar: calendarConfigSchema.prefault({}),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export type Localized = { ru: string; uk: string };
