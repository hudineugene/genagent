import { z } from "zod";
import { REPLY_LANGUAGES, type AgentConfig } from "@/lib/agent/types";
import { DEFAULT_MODEL } from "@/lib/models";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Общие настройки программы («Настройки», только администратор): студия и время, что включено у новых агентов,
 * тихие часы и лимит рассылок, лимит расходов ИИ студии и фоновые проверки. Хранятся в settings под ключом
 * "general". Читать в коде: await getGeneral(); там, где нужен синхронный ответ (часовой пояс, тихие часы), —
 * generalSync(): последнее прочитанное значение (обновляется не реже раза в 30 секунд) или значения по умолчанию.
 */
/** Валюта ссылок на оплату по умолчанию для новых настроек оплаты клиента */
export const CURRENCIES = ["UAH", "USD", "EUR"] as const;

export const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const generalSchema = z.object({
  studioName: z.string().trim().max(60).default("GenAgent"),
  timeZone: z.string().max(60).refine(validTimeZone, "bad_tz").default("Europe/Kyiv"),
  currency: z.enum(CURRENCIES).default("UAH"),
  locale: z.enum(["ru", "uk"]).default("ru"),
  newAgent: z
    .object({
      model: z.string().min(1).default(DEFAULT_MODEL),
      replyLanguage: z.enum(REPLY_LANGUAGES).default("auto"),
      aiDisclosure: z.boolean().default(true),
      quickReplies: z.boolean().default(true),
      streaming: z.boolean().default(true),
      answerCheck: z.boolean().default(true),
      monthlyBudgetUsd: z.number().min(0).max(100000).nullable().default(null),
    })
    .prefault({}),
  /** Не писать первыми с quietFrom до quietTo (часы по часовому поясу студии); равные — без тихих часов */
  quietFrom: z.number().int().min(0).max(23).default(21),
  quietTo: z.number().int().min(0).max(23).default(9),
  /** Сообщений рассылок и цепочек в сутки на один канал; null — без лимита */
  broadcastDailyLimit: z.number().int().min(1).max(100000).nullable().default(null),
  /** Лимит расходов ИИ всей студии в месяц, USD: на 80% и 100% — предупреждение в Telegram; null — без лимита */
  studioMonthlyLimitUsd: z.number().min(1).max(1000000).nullable().default(null),
  jobs: z
    .object({
      qualityCheck: z.boolean().default(true),
      gapsAnalysis: z.boolean().default(true),
      agentReview: z.boolean().default(true),
    })
    .prefault({}),
});

export type General = z.infer<typeof generalSchema>;

const DEFAULTS: General = generalSchema.parse({});
const TTL_MS = 30_000;
const g = globalThis as unknown as { __general?: { value: General; at: number } };

export async function getGeneral(): Promise<General> {
  if (g.__general && performance.now() - g.__general.at < TTL_MS) return g.__general.value;
  const raw = await getSetting<unknown>("general").catch(() => undefined);
  const parsed = generalSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : DEFAULTS;
  g.__general = { value, at: performance.now() };
  return value;
}

/** Без ожидания базы: последнее прочитанное значение; заодно обновляет его в фоне, если устарело. */
export function generalSync(): General {
  if (!g.__general || performance.now() - g.__general.at >= TTL_MS) void getGeneral().catch(() => {});
  return g.__general?.value ?? DEFAULTS;
}

export async function saveGeneral(input: unknown): Promise<General> {
  const value = generalSchema.parse(input);
  await setSetting("general", value);
  g.__general = { value, at: performance.now() };
  return value;
}

/** Часовой пояс студии для дат, расписаний и тихих часов. */
export const studioTz = () => generalSync().timeZone;

/** Час и минута сейчас по часовому поясу студии. */
export function studioClock(now = new Date(), tz = studioTz()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

/** Начало текущих суток по часовому поясу студии. */
export function studioDayStart(now = new Date()) {
  const c = studioClock(now);
  return new Date(now.getTime() - ((c.hour * 60 + c.minute) * 60 + c.second) * 1000 - now.getMilliseconds());
}

/** Сейчас тихие часы? Возвращает момент их окончания или null. */
export function quietEnd(now = new Date(), s = generalSync()): Date | null {
  const { quietFrom: from, quietTo: to } = s;
  if (from === to) return null;
  const { hour, minute } = studioClock(now, s.timeZone);
  const quiet = from < to ? hour >= from && hour < to : hour >= from || hour < to;
  if (!quiet) return null;
  const hoursLeft = (to - hour + 24) % 24 || 24;
  const end = new Date(now.getTime() + hoursLeft * 3600_000 - minute * 60_000);
  // Ночь перевода часов: сдвиг на час — поправить по часам студии
  const shift = ((to - studioClock(end, s.timeZone).hour + 36) % 24) - 12;
  return shift ? new Date(end.getTime() + shift * 3600_000) : end;
}

/** Настройки нового агента из общих настроек — поверх пустого шаблона, под настройками выбранного шаблона. */
export function newAgentBase(s: General): Partial<AgentConfig> {
  const n = s.newAgent;
  return {
    model: n.model,
    replyLanguage: n.replyLanguage,
    aiDisclosure: { enabled: n.aiDisclosure, text: "" },
    quickReplies: n.quickReplies,
    streaming: n.streaming,
    answerCheck: n.answerCheck,
    monthlyBudgetUsd: n.monthlyBudgetUsd,
  };
}
