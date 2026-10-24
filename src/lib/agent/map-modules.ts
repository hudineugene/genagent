/**
 * Модули карты агента (вкладка «Карта», карта клиента, кабинет владельца): группы, модули и их состояние по настройкам
 * агента, какие инструменты к какому модулю относятся, примерная цена в месяц, наборы модулей и порядок обработки сообщения.
 */
import {
  AudioLines,
  BadgeCheck,
  BookOpen,
  Bot,
  Brain,
  Calculator,
  CalendarDays,
  ClipboardList,
  CreditCard,
  FileText,
  Gift,
  Globe,
  GraduationCap,
  ListChecks,
  MessageSquareQuote,
  MousePointerClick,
  ScanEye,
  ShieldCheck,
  Sparkles,
  Table2,
  Truck,
  Users,
  Wallet,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AgentConfig } from "@/lib/agent/types";

export type L = { ru: string; uk: string };
export type Item = { id: string; name: string };
export type Lists = { kb: Item[]; tools: Item[]; forms: Item[]; procedures: Item[]; docs: Item[]; tables: Item[]; programs: Item[] };
export type Ready = { pricing: boolean; logistics: boolean; payments: boolean; courses: boolean; calendar: boolean; webSearch: boolean; voice: boolean };
export type Ctx = { lists: Lists; ready: Ready; clientId: string; agentId: string };
export type ListField = "toolIds" | "formIds" | "procedureIds" | "docTemplateIds" | "tableIds";
export type GroupKey = "knowledge" | "tools" | "sales" | "quality" | "voice";

export type Mod = {
  key: string;
  group: GroupKey;
  icon: LucideIcon;
  title: L;
  desc: L;
  on: (c: AgentConfig) => boolean;
  /** Простое включение и выключение */
  toggle?: (c: AgentConfig, on: boolean) => Partial<AgentConfig>;
  /** Выбор из списка клиента (инструменты, анкеты…) */
  pick?: { list: keyof Lists; field: ListField };
  /** Включён, но чего-то не хватает */
  warn?: (c: AgentConfig, x: Ctx) => L | null;
  /** Полные настройки */
  href: (x: Ctx) => string;
  /** Подробность на карточке: число выбранного, режим */
  detail?: (c: AgentConfig, x: Ctx) => string | null;
};

export const GROUPS: { key: GroupKey; title: L; icon: LucideIcon }[] = [
  { key: "knowledge", title: { ru: "Знания", uk: "Знання" }, icon: BookOpen },
  { key: "tools", title: { ru: "Инструменты и данные", uk: "Інструменти і дані" }, icon: Wrench },
  { key: "sales", title: { ru: "Продажи и услуги", uk: "Продажі та послуги" }, icon: CreditCard },
  { key: "quality", title: { ru: "Качество и контроль", uk: "Якість і контроль" }, icon: ShieldCheck },
  { key: "voice", title: { ru: "Голос и общение", uk: "Голос і спілкування" }, icon: AudioLines },
];

const builder = (x: Ctx, section: string) => `/agents/${x.agentId}#section-${section}`;
const client = (x: Ctx, tab: string) => `/clients/${x.clientId}?tab=${tab}`;
const n = (ids: string[] | undefined) => (ids?.length ? String(ids.length) : null);

export const MODULES: Mod[] = [
  {
    key: "kb",
    group: "knowledge",
    icon: BookOpen,
    title: { ru: "База знаний", uk: "База знань" },
    desc: { ru: "Сайт, файлы и тексты клиента: агент отвечает только по ним.", uk: "Сайт, файли й тексти клієнта: агент відповідає лише за ними." },
    on: (c) => c.kbSourceIds === null || c.kbSourceIds.length > 0,
    warn: (c, x) => (x.lists.kb.length === 0 ? { ru: "У клиента ещё нет источников базы знаний", uk: "У клієнта ще немає джерел бази знань" } : null),
    href: (x) => client(x, "kb"),
    detail: (c, x) => (c.kbSourceIds === null ? `${x.lists.kb.length}` : `${c.kbSourceIds.length}/${x.lists.kb.length}`),
  },
  {
    key: "facts",
    group: "knowledge",
    icon: Sparkles,
    title: { ru: "Ключевые факты", uk: "Ключові факти" },
    desc: { ru: "Короткий список главного (цены, адреса, график) прямо в инструкции агента.", uk: "Короткий список головного (ціни, адреси, графік) просто в інструкції агента." },
    on: (c) => c.knowledge.trim().length > 0,
    href: (x) => builder(x, "knowledge"),
  },
  {
    key: "memory",
    group: "knowledge",
    icon: Brain,
    title: { ru: "Память о клиенте", uk: "Пам'ять про клієнта" },
    desc: { ru: "Агент помнит факты из прошлых разговоров с этим человеком.", uk: "Агент пам'ятає факти з минулих розмов із цією людиною." },
    on: (c) => c.memory,
    toggle: (_c, on) => ({ memory: on }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "web",
    group: "knowledge",
    icon: Globe,
    title: { ru: "Поиск в интернете", uk: "Пошук в інтернеті" },
    desc: { ru: "Общие сведения, которых нет в базе знаний: новости, законы, курсы.", uk: "Загальні відомості, яких немає в базі знань: новини, закони, курси." },
    on: (c) => Boolean(c.webSearch),
    toggle: (_c, on) => ({ webSearch: on }),
    warn: (_c, x) => (x.ready.webSearch ? null : { ru: "Поиск выключен в «Интеграции» → «Внешние сервисы»", uk: "Пошук вимкнено в «Інтеграції» → «Зовнішні сервіси»" }),
    href: (x) => builder(x, "tools"),
  },
  {
    key: "tools",
    group: "tools",
    icon: Wrench,
    title: { ru: "Свои инструменты, CRM и MCP", uk: "Свої інструменти, CRM і MCP" },
    desc: { ru: "API клиента, готовые подключения CRM и магазинов, MCP-серверы.", uk: "API клієнта, готові підключення CRM і магазинів, MCP-сервери." },
    on: (c) => Boolean(c.toolIds?.length),
    pick: { list: "tools", field: "toolIds" },
    href: (x) => client(x, "tools"),
    detail: (c) => n(c.toolIds),
  },
  {
    key: "tables",
    group: "tools",
    icon: Table2,
    title: { ru: "Таблицы данных", uk: "Таблиці даних" },
    desc: { ru: "Прайсы, остатки, заказы: точные ответы и расчёты по таблицам.", uk: "Прайси, залишки, замовлення: точні відповіді й розрахунки за таблицями." },
    on: (c) => Boolean(c.tableIds?.length),
    pick: { list: "tables", field: "tableIds" },
    href: (x) => client(x, "data"),
    detail: (c) => n(c.tableIds),
  },
  {
    key: "forms",
    group: "tools",
    icon: ClipboardList,
    title: { ru: "Анкеты и тесты", uk: "Анкети й тести" },
    desc: { ru: "Агент проводит анкету в разговоре, ответы сохраняются.", uk: "Агент проводить анкету в розмові, відповіді зберігаються." },
    on: (c) => Boolean(c.formIds?.length),
    pick: { list: "forms", field: "formIds" },
    href: (x) => client(x, "forms"),
    detail: (c) => n(c.formIds),
  },
  {
    key: "procedures",
    group: "tools",
    icon: ListChecks,
    title: { ru: "Процедуры", uk: "Процедури" },
    desc: { ru: "Обязательные шаги (возврат, рекламация): их ведёт программа.", uk: "Обов'язкові кроки (повернення, рекламація): їх веде програма." },
    on: (c) => Boolean(c.procedureIds?.length),
    pick: { list: "procedures", field: "procedureIds" },
    href: (x) => client(x, "procedures"),
    detail: (c) => n(c.procedureIds),
  },
  {
    key: "docs",
    group: "tools",
    icon: FileText,
    title: { ru: "Документы для клиентов", uk: "Документи для клієнтів" },
    desc: { ru: "КП, справки и другие документы по шаблону — ссылкой в чате.", uk: "КП, довідки та інші документи за шаблоном — посиланням у чаті." },
    on: (c) => Boolean(c.docTemplateIds?.length),
    pick: { list: "docs", field: "docTemplateIds" },
    href: (x) => client(x, "documents"),
    detail: (c) => n(c.docTemplateIds),
  },
  {
    key: "calendar",
    group: "tools",
    icon: CalendarDays,
    title: { ru: "Запись в календарь", uk: "Запис у календар" },
    desc: { ru: "Свободные окна и запись на услуги в Google Календаре.", uk: "Вільні вікна й запис на послуги в Google Календарі." },
    on: (c) => c.calendar.enabled,
    toggle: (c, on) => ({ calendar: { ...c.calendar, enabled: on } }),
    warn: (c, x) =>
      !x.ready.calendar
        ? { ru: "Google не подключён в «Интеграциях»", uk: "Google не підключено в «Інтеграціях»" }
        : !c.calendar.calendarId
          ? { ru: "Не указан календарь", uk: "Не вказано календар" }
          : null,
    href: (x) => builder(x, "calendar"),
  },
  {
    key: "logistics",
    group: "tools",
    icon: Truck,
    title: { ru: "Расчёт доставки", uk: "Розрахунок доставки" },
    desc: { ru: "Расстояние и время в пути от склада, ответы водителям и получателям.", uk: "Відстань і час у дорозі від складу, відповіді водіям і отримувачам." },
    on: (c) => Boolean(c.logistics),
    toggle: (_c, on) => ({ logistics: on }),
    warn: (_c, x) => (x.ready.logistics ? null : { ru: "Не задан склад в «Логистике»", uk: "Не задано склад у «Логістиці»" }),
    href: (x) => client(x, "logistics"),
  },
  {
    key: "payments",
    group: "sales",
    icon: CreditCard,
    title: { ru: "Ссылки на оплату", uk: "Посилання на оплату" },
    desc: { ru: "LiqPay, WayForPay, Monobank: ссылка в чате и подтверждение оплаты.", uk: "LiqPay, WayForPay, Monobank: посилання в чаті й підтвердження оплати." },
    on: (c) => Boolean(c.payments),
    toggle: (_c, on) => ({ payments: on }),
    warn: (_c, x) => (x.ready.payments ? null : { ru: "Оплата не настроена у клиента", uk: "Оплату не налаштовано в клієнта" }),
    href: (x) => client(x, "payments"),
  },
  {
    key: "pricing",
    group: "sales",
    icon: Calculator,
    title: { ru: "Расчёт КП", uk: "Розрахунок КП" },
    desc: { ru: "Суммы по прайсу, скидкам и НДС считает программа, а не модель.", uk: "Суми за прайсом, знижками й ПДВ рахує програма, а не модель." },
    on: (c) => Boolean(c.pricing),
    toggle: (_c, on) => ({ pricing: on }),
    warn: (_c, x) => (x.ready.pricing ? null : { ru: "Не выбрана таблица цен в «Расчёте цен»", uk: "Не обрано таблицю цін у «Розрахунку цін»" }),
    href: (x) => client(x, "pricing"),
  },
  {
    key: "loyalty",
    group: "sales",
    icon: Gift,
    title: { ru: "Баллы лояльности", uk: "Бали лояльності" },
    desc: { ru: "Баланс клиента и обмен баллов на награды в чате.", uk: "Баланс клієнта й обмін балів на нагороди в чаті." },
    on: (c) => Boolean(c.loyaltyProgramId),
    href: (x) => client(x, "loyalty"),
    detail: (c, x) => x.lists.programs.find((p) => p.id === c.loyaltyProgramId)?.name ?? null,
  },
  {
    key: "learning",
    group: "sales",
    icon: GraduationCap,
    title: { ru: "Обучение в чате", uk: "Навчання в чаті" },
    desc: { ru: "Курсы по урокам с тестами и баллами прямо в мессенджере.", uk: "Курси за уроками з тестами й балами просто в месенджері." },
    on: (c) => Boolean(c.learning),
    toggle: (_c, on) => ({ learning: on }),
    warn: (_c, x) => (x.ready.courses ? null : { ru: "У клиента нет курсов", uk: "У клієнта немає курсів" }),
    href: (x) => client(x, "learning"),
  },
  {
    key: "team",
    group: "sales",
    icon: Users,
    title: { ru: "Агент для сотрудников", uk: "Агент для співробітників" },
    desc: { ru: "Отвечает только людям из списка, оформляет заявки на согласование.", uk: "Відповідає лише людям зі списку, оформлює заявки на погодження." },
    on: (c) => Boolean(c.team?.enabled),
    toggle: (c, on) => ({ team: { enabled: on, allowed: c.team?.allowed ?? "", denyText: c.team?.denyText ?? "", approvals: c.team?.approvals ?? false, approvers: c.team?.approvers ?? "owners" } }),
    warn: (c) => (c.team?.allowed.trim() ? null : { ru: "Не указано, кому отвечать", uk: "Не вказано, кому відповідати" }),
    href: (x) => builder(x, "team"),
  },
  {
    key: "factGuard",
    group: "quality",
    icon: ScanEye,
    title: { ru: "Проверка фактов", uk: "Перевірка фактів" },
    desc: { ru: "Ловит цены, телефоны и ссылки, которых нет в базе знаний.", uk: "Ловить ціни, телефони й посилання, яких немає в базі знань." },
    on: (c) => c.factGuard !== "off",
    toggle: (_c, on) => ({ factGuard: on ? "flag" : "off" }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "answerCheck",
    group: "quality",
    icon: BadgeCheck,
    title: { ru: "Проверка ответа", uk: "Перевірка відповіді" },
    desc: { ru: "Вторая модель проверяет ответ до отправки и при проблеме переписывает.", uk: "Друга модель перевіряє відповідь до надсилання й за проблеми переписує." },
    on: (c) => Boolean(c.answerCheck),
    toggle: (_c, on) => ({ answerCheck: on }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "quality",
    group: "quality",
    icon: ShieldCheck,
    title: { ru: "Утренняя проверка качества", uk: "Ранкова перевірка якості" },
    desc: { ru: "Раз в сутки сильная модель разбирает вчерашние ответы.", uk: "Раз на добу сильна модель розбирає вчорашні відповіді." },
    on: (c) => c.qualityCheck,
    toggle: (_c, on) => ({ qualityCheck: on }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "operatorReview",
    group: "quality",
    icon: MessageSquareQuote,
    title: { ru: "Оценка ответов сотрудников", uk: "Оцінка відповідей співробітників" },
    desc: { ru: "Ответы менеджеров клиентам оцениваются по тем же правилам.", uk: "Відповіді менеджерів клієнтам оцінюються за тими самими правилами." },
    on: (c) => Boolean(c.operatorReview),
    toggle: (_c, on) => ({ operatorReview: on }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "disclosure",
    group: "quality",
    icon: Bot,
    title: { ru: "Сообщать, что это ИИ", uk: "Повідомляти, що це ШІ" },
    desc: { ru: "Первый ответ в разговоре начинается строкой об ИИ-ассистенте.", uk: "Перша відповідь у розмові починається рядком про ШІ-асистента." },
    on: (c) => Boolean(c.aiDisclosure?.enabled),
    toggle: (c, on) => ({ aiDisclosure: { enabled: on, text: c.aiDisclosure?.text ?? "" } }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "budget",
    group: "quality",
    icon: Wallet,
    title: { ru: "Лимит расходов", uk: "Ліміт витрат" },
    desc: { ru: "Месячный лимит агента: исчерпан — агент молчит и зовёт менеджера.", uk: "Місячний ліміт агента: вичерпано — агент мовчить і кличе менеджера." },
    on: (c) => c.monthlyBudgetUsd != null,
    toggle: (c, on) => ({ monthlyBudgetUsd: on ? (c.monthlyBudgetUsd ?? 20) : null }),
    href: (x) => builder(x, "model"),
    detail: (c) => (c.monthlyBudgetUsd != null ? `$${c.monthlyBudgetUsd}` : null),
  },
  {
    key: "voiceReplies",
    group: "voice",
    icon: AudioLines,
    title: { ru: "Ответ голосом", uk: "Відповідь голосом" },
    desc: { ru: "На голосовое сообщение клиента агент отвечает голосовым.", uk: "На голосове повідомлення клієнта агент відповідає голосовим." },
    on: (c) => c.voiceReplies,
    toggle: (_c, on) => ({ voiceReplies: on }),
    warn: (_c, x) => (x.ready.voice ? null : { ru: "Нет ключа OpenAI", uk: "Немає ключа OpenAI" }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "streaming",
    group: "voice",
    icon: Zap,
    title: { ru: "Ответ по мере написания", uk: "Відповідь у міру написання" },
    desc: { ru: "В Telegram клиент видит ответ сразу, слово за словом.", uk: "У Telegram клієнт бачить відповідь одразу, слово за словом." },
    on: (c) => Boolean(c.streaming),
    toggle: (_c, on) => ({ streaming: on }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "quickReplies",
    group: "voice",
    icon: MousePointerClick,
    title: { ru: "Кнопки быстрых ответов", uk: "Кнопки швидких відповідей" },
    desc: { ru: "2–4 варианта ответа кнопками в Telegram, Viber и Messenger.", uk: "2–4 варіанти відповіді кнопками в Telegram, Viber і Messenger." },
    on: (c) => Boolean(c.quickReplies),
    toggle: (_c, on) => ({ quickReplies: on }),
    href: (x) => builder(x, "model"),
  },
  {
    key: "brandVoice",
    group: "voice",
    icon: MessageSquareQuote,
    title: { ru: "Голос бренда", uk: "Голос бренду" },
    desc: { ru: "Агент пишет в стиле, описанном у клиента.", uk: "Агент пише в стилі, описаному в клієнта." },
    on: (c) => c.useBrandVoice,
    toggle: (_c, on) => ({ useBrandVoice: on }),
    href: (x) => builder(x, "style"),
  },
];

export const CHANNEL_LABEL: Record<string, string> = {
  telegram: "Telegram",
  widget: "Виджет",
  instagram: "Instagram",
  threads: "Threads",
  email: "Email",
  api: "API",
  whatsapp: "WhatsApp",
  viber: "Viber",
  voice: "Звонки",
  messenger: "Messenger",
  sms: "SMS",
};

/** Работа агента за 7 дней (lib/agent/map-stats.ts): разговоры по каналам, срабатывания модулей, расходы. */
export type MapStats = {
  replies: number;
  conversations: number;
  costUsd: number;
  handoffs: number;
  voiceIn: number;
  operatorReplies: number;
  /** stale — неделю (или ни разу) без сообщений клиентов */
  channels: Record<string, { conversations: number; errors: number; lastInbound: number | null; stale: boolean }>;
  modules: Record<string, { uses: number; errors: number }>;
  /** За 30 дней по дням (старые → новые): разговоры по каналам, срабатывания модулей, ответы агента */
  daily: { channels: Record<string, number[]>; modules: Record<string, number[]>; replies: number[] };
};

/** К какому модулю карты относится вызванный инструмент агента (свои инструменты, CRM и MCP — «tools»). */
export function toolModule(name: string): string {
  if (name.startsWith("form_")) return "forms";
  if (name.startsWith("table_")) return "tables";
  if (name.startsWith("doc_")) return "docs";
  if (name === "start_procedure") return "procedures";
  if (name === "create_payment_link" || name === "check_payment") return "payments";
  if (name === "calc_quote") return "pricing";
  if (name.startsWith("loyalty_")) return "loyalty";
  if (name.startsWith("learning_")) return "learning";
  if (name.startsWith("delivery_") || name.startsWith("trip_")) return "logistics";
  if (name === "find_free_slots" || name === "book_appointment") return "calendar";
  if (name === "web_search") return "web";
  if (name === "request_approval" || name.startsWith("onboarding_")) return "team";
  return "tools";
}

const month = (per7: number) => (per7 * 30) / 7;
const usd = (v: number) => (v < 0.01 ? "<$0.01" : v < 10 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);
const free: L = { ru: "бесплатно: считает программа", uk: "безкоштовно: рахує програма" };

/** Примерная цена модуля в месяц при нынешнем объёме (по тарифам из «Помощь» → «Сколько стоит»); null — без отдельной цены. */
export function moduleCost(key: string, s: MapStats | null): L | null {
  const replies = month(s?.replies ?? 0);
  const conv = month(s?.conversations ?? 0);
  const est = (v: number, ru: string, uk: string): L => ({ ru: `≈ ${usd(v)} в месяц · ${ru}`, uk: `≈ ${usd(v)} на місяць · ${uk}` });
  switch (key) {
    case "answerCheck":
      return est(replies * 0.001, "$0.001 за ответ", "$0.001 за відповідь");
    case "operatorReview":
      return est(month(s?.operatorReplies ?? 0) * 0.001, "$0.001 за ответ сотрудника", "$0.001 за відповідь співробітника");
    case "quality":
      return conv > 0 ? { ru: "≈ $1.5–4.5 в месяц · $0.05–0.15 в день с разговорами", uk: "≈ $1.5–4.5 на місяць · $0.05–0.15 на день із розмовами" } : { ru: "$0 — нет разговоров", uk: "$0 — немає розмов" };
    case "memory":
      return est(conv * 0.0005, "дешёвая модель после разговора", "дешева модель після розмови");
    case "web":
      return est(month(s?.modules.web?.uses ?? 0) * 0.01, "$0.01 за поиск", "$0.01 за пошук");
    case "voiceReplies":
      return est(month(s?.voiceIn ?? 0) * 0.5 * 0.015, "$0.015 за минуту речи", "$0.015 за хвилину мовлення");
    case "logistics":
      return est(month(s?.modules.logistics?.uses ?? 0) * 0.01, "Google Maps, до $0.01 за расчёт", "Google Maps, до $0.01 за розрахунок");
    case "factGuard":
    case "pricing":
    case "procedures":
      return free;
    case "payments":
      return { ru: "комиссия банка клиента; ссылка — бесплатно", uk: "комісія банку клієнта; посилання — безкоштовно" };
    default:
      return null;
  }
}

/** Готовые наборы модулей: включают нужное (выбор списков не трогают — их делают в панели модуля). */
export const PRESETS: { key: string; title: L; desc: L; patch: (c: AgentConfig) => Partial<AgentConfig> }[] = [
  {
    key: "sales",
    title: { ru: "Продавец", uk: "Продавець" },
    desc: { ru: "Оплата, расчёт КП, кнопки, проверки ответа и фактов", uk: "Оплата, розрахунок КП, кнопки, перевірки відповіді й фактів" },
    patch: (c) => ({ payments: true, pricing: true, quickReplies: true, answerCheck: true, factGuard: c.factGuard === "off" ? "flag" : c.factGuard, memory: true }),
  },
  {
    key: "booking",
    title: { ru: "Запись на услуги", uk: "Запис на послуги" },
    desc: { ru: "Календарь, кнопки, память о клиенте, проверка ответа", uk: "Календар, кнопки, пам'ять про клієнта, перевірка відповіді" },
    patch: (c) => ({ calendar: { ...c.calendar, enabled: true }, quickReplies: true, memory: true, answerCheck: true }),
  },
  {
    key: "support",
    title: { ru: "Поддержка", uk: "Підтримка" },
    desc: { ru: "Проверки ответа и фактов, утренняя проверка, оценка сотрудников, лимит", uk: "Перевірки відповіді й фактів, ранкова перевірка, оцінка співробітників, ліміт" },
    patch: (c) => ({ answerCheck: true, factGuard: c.factGuard === "off" ? "flag" : c.factGuard, qualityCheck: true, operatorReview: true, monthlyBudgetUsd: c.monthlyBudgetUsd ?? 20 }),
  },
  {
    key: "economy",
    title: { ru: "Экономный", uk: "Економний" },
    desc: { ru: "Выключает платные проверки и поиск, ставит лимит $10", uk: "Вимикає платні перевірки й пошук, ставить ліміт $10" },
    patch: () => ({ answerCheck: false, operatorReview: false, webSearch: false, qualityCheck: false, monthlyBudgetUsd: 10 }),
  },
];

/** Как программа обрабатывает сообщение клиента — по порядку (lib/conversations.ts → respond). module — шаг зависит от модуля. */
export const PIPELINE: { title: L; desc: L; module?: string }[] = [
  { title: { ru: "Входящее сообщение", uk: "Вхідне повідомлення" }, desc: { ru: "Голосовое расшифровывается, фото описывается, документ читается", uk: "Голосове розшифровується, фото описується, документ читається" } },
  { title: { ru: "Разговор у менеджера?", uk: "Розмова в менеджера?" }, desc: { ru: "Менеджер только что ответил или ждёт одобрения черновик — агент молчит", uk: "Менеджер щойно відповів або чекає схвалення чернетка — агент мовчить" } },
  { title: { ru: "Доступ сотрудников", uk: "Доступ співробітників" }, desc: { ru: "Агент для сотрудников отвечает только людям из списка", uk: "Агент для співробітників відповідає лише людям зі списку" }, module: "team" },
  { title: { ru: "Процедура", uk: "Процедура" }, desc: { ru: "Идёт процедура — следующий шаг задаёт программа, без модели", uk: "Іде процедура — наступний крок задає програма, без моделі" }, module: "procedures" },
  { title: { ru: "Лимиты расходов", uk: "Ліміти витрат" }, desc: { ru: "Лимит агента или клиента исчерпан — агент молчит и зовёт менеджера", uk: "Ліміт агента або клієнта вичерпано — агент мовчить і кличе менеджера" } },
  { title: { ru: "Инструкция и знания", uk: "Інструкція і знання" }, desc: { ru: "Роль, правила, ключевые факты, найденное в базе знаний, память о клиенте", uk: "Роль, правила, ключові факти, знайдене в базі знань, пам'ять про клієнта" } },
  { title: { ru: "Модель ИИ и инструменты", uk: "Модель ШІ та інструменти" }, desc: { ru: "Модель пишет ответ и при необходимости вызывает инструменты", uk: "Модель пише відповідь і за потреби викликає інструменти" } },
  { title: { ru: "Проверка ответа", uk: "Перевірка відповіді" }, desc: { ru: "Вторая модель проверяет и при проблеме один раз переписывает", uk: "Друга модель перевіряє й за проблеми один раз переписує" }, module: "answerCheck" },
  { title: { ru: "Защита инструкций", uk: "Захист інструкцій" }, desc: { ru: "Пересказ служебных инструкций заменяется отказом", uk: "Переказ службових інструкцій замінюється відмовою" } },
  { title: { ru: "«Это ИИ»", uk: "«Це ШІ»" }, desc: { ru: "Первый ответ в разговоре начинается строкой об ИИ-ассистенте", uk: "Перша відповідь у розмові починається рядком про ШІ-асистента" }, module: "disclosure" },
  { title: { ru: "Проверка фактов", uk: "Перевірка фактів" }, desc: { ru: "Цены, телефоны и ссылки не из базы знаний помечаются или задерживаются", uk: "Ціни, телефони й посилання не з бази знань позначаються або затримуються" }, module: "factGuard" },
  { title: { ru: "Отправка", uk: "Надсилання" }, desc: { ru: "В канал клиента: с кнопками, голосом или по мере написания", uk: "У канал клієнта: з кнопками, голосом або в міру написання" } },
  { title: { ru: "После ответа", uk: "Після відповіді" }, desc: { ru: "Карточка лида, передача менеджеру с выжимкой, обновление памяти", uk: "Картка ліда, передача менеджеру з вижимкою, оновлення пам'яті" } },
];

/** Модули, которые включены в одной конфигурации и выключены в другой (сравнение версий). */
export function modulesDiff(now: AgentConfig, other: AgentConfig): Record<string, "added" | "removed"> {
  const out: Record<string, "added" | "removed"> = {};
  for (const m of MODULES) {
    const a = m.on(now);
    const b = m.on(other);
    if (a !== b) out[m.key] = a ? "added" : "removed";
  }
  return out;
}

/** Изменение модуля между версиями агента (история модуля). */
export type ModuleChange = { version: number; at: number; by: string | null; on: boolean };
/** Покрытие тестами по последнему прогону: модули, сработавшие хотя бы в одном сценарии. */
export type MapCoverage = { version: number; at: number | null; total: number; passed: number; modules: string[]; recorded: boolean };
/** Шаг повтора разговора. */
export type ReplayStep = {
  role: "customer" | "agent" | "manager" | "bot" | "event";
  text: string;
  at: number;
  modules: { key: string; error: boolean }[];
  sources?: string[];
  tools?: string[];
  check?: { ok: boolean; problems: string[]; rewritten: boolean };
  unverified?: string[];
  cost?: number;
  ms?: number;
  handoff?: boolean;
  error?: boolean;
};
/** Событие живого режима. */
export type LiveEvent = { kind: "in" | "reply" | "error"; channelId: string | null; modules?: { key: string; error: boolean }[] };

/** Модули, которые проверяются тестами по вызову инструментов (у остальных покрытие не определить). */
export const TESTABLE = new Set(["kb", "tools", "tables", "forms", "procedures", "docs", "calendar", "logistics", "payments", "pricing", "loyalty", "learning", "web", "team"]);

/**
 * Связи модулей: one — модуль, другой нужен ему (или усиливает его). Показываются линией при выборе модуля
 * и подсказкой в панели, если связка неполная.
 */
export const DEPENDENCIES: { from: string; to: string; why: L; required?: boolean }[] = [
  { from: "payments", to: "pricing", why: { ru: "Сумму оплаты агент берёт из прайса или расчёта КП", uk: "Суму оплати агент бере з прайсу або розрахунку КП" } },
  { from: "payments", to: "kb", why: { ru: "Без прайса в базе знаний агенту неоткуда взять сумму", uk: "Без прайсу в базі знань агенту нема звідки взяти суму" } },
  { from: "pricing", to: "tables", why: { ru: "Расчёт КП берёт цены из таблицы прайса", uk: "Розрахунок КП бере ціни з таблиці прайсу" }, required: true },
  { from: "procedures", to: "tools", why: { ru: "Шаги процедуры могут смотреть данные в CRM и инструментах", uk: "Кроки процедури можуть дивитися дані в CRM та інструментах" } },
  { from: "loyalty", to: "tools", why: { ru: "Баллы за покупки могут приходить из CRM", uk: "Бали за покупки можуть надходити з CRM" } },
  { from: "learning", to: "loyalty", why: { ru: "Баллы за уроки начисляются в программу лояльности", uk: "Бали за уроки нараховуються в програму лояльності" } },
  { from: "answerCheck", to: "kb", why: { ru: "Проверка сверяет ответ с базой знаний", uk: "Перевірка звіряє відповідь із базою знань" } },
  { from: "factGuard", to: "kb", why: { ru: "Проверка фактов ищет цены и телефоны в базе знаний", uk: "Перевірка фактів шукає ціни й телефони в базі знань" }, required: true },
  { from: "calendar", to: "quickReplies", why: { ru: "Свободные окна удобно предлагать кнопками", uk: "Вільні вікна зручно пропонувати кнопками" } },
  { from: "voiceReplies", to: "brandVoice", why: { ru: "Голосом звучит тот же стиль бренда", uk: "Голосом звучить той самий стиль бренду" } },
];

/** Связи, которые сейчас не выполнены: модуль включён, а нужный ему — нет (required — без него не работает). */
export function brokenLinks(c: AgentConfig): typeof DEPENDENCIES {
  const on = (k: string) => MODULES.find((m) => m.key === k)?.on(c) ?? false;
  return DEPENDENCIES.filter((d) => on(d.from) && !on(d.to));
}

/** «Что будет, если…»: последствия изменения модуля по данным за 7 дней. */
export function whatIf(key: string, turnOn: boolean, s: MapStats | null): L | null {
  const m = s?.modules[key];
  const cost = moduleCost(key, s);
  const costText = cost ? cost.ru.split(" · ")[0].replace("≈ ", "") : null;
  const costTextUk = cost ? cost.uk.split(" · ")[0].replace("≈ ", "") : null;
  if (!turnOn) {
    if (key === "answerCheck") return { ru: `Экономия ${costText ?? "—"}, но за 7 дней проверка нашла проблемы в ${m?.errors ?? 0} ответах — клиенты получили бы их без исправления`, uk: `Економія ${costTextUk ?? "—"}, але за 7 днів перевірка знайшла проблеми в ${m?.errors ?? 0} відповідях — клієнти отримали б їх без виправлення` };
    if (key === "factGuard") return { ru: `За 7 дней помечено ответов с непроверенными фактами: ${m?.uses ?? 0} — без проверки их никто не увидит`, uk: `За 7 днів позначено відповідей із неперевіреними фактами: ${m?.uses ?? 0} — без перевірки їх ніхто не побачить` };
    if (m?.uses) return { ru: `За 7 дней модуль сработал ${m.uses} раз — эти действия агент больше делать не сможет`, uk: `За 7 днів модуль спрацював ${m.uses} разів — ці дії агент більше робити не зможе` };
    return costText ? { ru: `Экономия ${costText}; за 7 дней модуль не срабатывал`, uk: `Економія ${costTextUk}; за 7 днів модуль не спрацьовував` } : { ru: "За 7 дней модуль не срабатывал — потерь не видно", uk: "За 7 днів модуль не спрацьовував — втрат не видно" };
  }
  return cost ? { ru: `Добавит ${costText}`, uk: `Додасть ${costTextUk}` } : null;
}
