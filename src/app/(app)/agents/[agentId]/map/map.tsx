"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type RefObject } from "react";
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
  ExternalLink,
  FileText,
  Gift,
  Globe,
  GraduationCap,
  ListChecks,
  MessageSquareQuote,
  MousePointerClick,
  Plus,
  Radio,
  ScanEye,
  ShieldCheck,
  Sparkles,
  Table2,
  Truck,
  Users,
  Wallet,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { saveAgent } from "@/app/actions/agents";
import type { AgentConfig } from "@/lib/agent/types";
import { EFFORTS, REPLY_LANGUAGES, TONES } from "@/lib/agent/types";
import { useI18n } from "@/lib/i18n/client";
import { Badge, Button, Input, Select, SwitchButton, cx } from "@/components/ui";

type L = { ru: string; uk: string };
type Item = { id: string; name: string };
type Lists = { kb: Item[]; tools: Item[]; forms: Item[]; procedures: Item[]; docs: Item[]; tables: Item[]; programs: Item[] };
type Ready = { pricing: boolean; logistics: boolean; payments: boolean; courses: boolean; calendar: boolean; webSearch: boolean; voice: boolean };
type Ctx = { lists: Lists; ready: Ready; clientId: string; agentId: string };
type ListField = "toolIds" | "formIds" | "procedureIds" | "docTemplateIds" | "tableIds";
type GroupKey = "knowledge" | "tools" | "sales" | "quality" | "voice";

type Mod = {
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

const GROUPS: { key: GroupKey; title: L; icon: LucideIcon }[] = [
  { key: "knowledge", title: { ru: "Знания", uk: "Знання" }, icon: BookOpen },
  { key: "tools", title: { ru: "Инструменты и данные", uk: "Інструменти і дані" }, icon: Wrench },
  { key: "sales", title: { ru: "Продажи и услуги", uk: "Продажі та послуги" }, icon: CreditCard },
  { key: "quality", title: { ru: "Качество и контроль", uk: "Якість і контроль" }, icon: ShieldCheck },
  { key: "voice", title: { ru: "Голос и общение", uk: "Голос і спілкування" }, icon: AudioLines },
];

const builder = (x: Ctx, section: string) => `/agents/${x.agentId}#section-${section}`;
const client = (x: Ctx, tab: string) => `/clients/${x.clientId}?tab=${tab}`;
const n = (ids: string[] | undefined) => (ids?.length ? String(ids.length) : null);

const MODULES: Mod[] = [
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

const CHANNEL_LABEL: Record<string, string> = {
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

type AgentView = { id: string; name: string; status: "draft" | "active" | "paused"; version: number; config: AgentConfig };
type Selected = { kind: "core" } | { kind: "mod"; key: string } | null;

export function AgentMap({
  agent,
  clientId,
  channels,
  lists,
  ready,
  models,
}: {
  agent: AgentView;
  clientId: string;
  channels: { id: string; type: string; name: string; enabled: boolean }[];
  lists: Lists;
  ready: Ready;
  models: { id: string; label: string }[];
}) {
  const { t, locale } = useI18n();
  const tr = (l: L) => l[locale];
  const router = useRouter();
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [saved, setSaved] = useState<AgentConfig>(agent.config);
  const [selected, setSelected] = useState<Selected>(null);
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();
  const ctx: Ctx = { lists, ready, clientId, agentId: agent.id };
  const dirty = JSON.stringify(config) !== JSON.stringify(saved);
  const patch = (p: Partial<AgentConfig>) => setConfig((c) => ({ ...c, ...p }));

  const save = () =>
    start(async () => {
      setError(false);
      try {
        await saveAgent(agent.id, { name: agent.name, status: agent.status, config });
        setSaved(config);
        router.refresh();
      } catch {
        setError(true);
      }
    });

  const state = (m: Mod) => (m.on(config) ? (m.warn?.(config, ctx) ? "warn" : "on") : "off");
  const groupOn = (g: GroupKey) => MODULES.some((m) => m.group === g && m.on(config));
  const model = models.find((m) => m.id === config.model)?.label ?? config.model;
  const current = selected?.kind === "mod" ? MODULES.find((m) => m.key === selected.key) : undefined;

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const paths = useLines(rootRef, [channels.length, config, selected]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          {locale === "uk"
            ? "Схема агента: звідки приходять клієнти, ядро і модулі. Перемикач вмикає модуль, клік — його налаштування."
            : "Схема агента: откуда приходят клиенты, ядро и модули. Переключатель включает модуль, щелчок — его настройки."}
        </p>
        <Legend locale={locale} />
      </div>

      {dirty && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/40 bg-surface/95 p-3 shadow-sm backdrop-blur">
          <span className="flex-1 text-sm font-medium">{locale === "uk" ? "Є незбережені зміни" : "Есть несохранённые изменения"}</span>
          {error && <span className="text-sm text-danger">{locale === "uk" ? "Не збереглося" : "Не сохранилось"}</span>}
          <Button variant="ghost" disabled={pending} onClick={() => setConfig(saved)}>
            {locale === "uk" ? "Скасувати" : "Отменить"}
          </Button>
          <Button disabled={pending} onClick={save}>
            {locale === "uk" ? "Зберегти нову версію" : "Сохранить новую версию"}
          </Button>
        </div>
      )}

      <div>
        <div ref={rootRef} className="relative min-w-0">
          <svg className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block" aria-hidden>
            {paths.map((p) => (
              <path key={p.id} d={p.d} fill="none" strokeWidth={p.active ? 2 : 1.5} strokeDasharray={p.active ? undefined : "4 4"} className={p.active ? "stroke-accent/60" : "stroke-border"} />
            ))}
          </svg>
          <div className="relative grid gap-4 lg:grid-cols-[200px_220px_minmax(0,1fr)] lg:items-center lg:gap-14">
            {/* Каналы */}
            <div className="space-y-2">
              <ColumnTitle icon={Radio} text={locale === "uk" ? "Канали" : "Каналы"} />
              {channels.map((ch) => (
                <Link key={ch.id} data-node={`ch-${ch.id}`} href={`/agents/${agent.id}/channels`} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm transition hover:border-accent/50">
                  <Dot state={ch.enabled ? "on" : "off"} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{CHANNEL_LABEL[ch.type] ?? ch.type}</span>
                    <span className="block truncate text-xs text-muted">{ch.name}</span>
                  </span>
                </Link>
              ))}
              <Link data-node="ch-add" href={`/agents/${agent.id}/channels`} className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted transition hover:border-accent/50 hover:text-text">
                <Plus className="size-4" />
                {locale === "uk" ? "Підключити канал" : "Подключить канал"}
              </Link>
            </div>

            {/* Ядро */}
            <button
              type="button"
              data-node="core"
              onClick={() => setSelected({ kind: "core" })}
              className={cx("rounded-2xl border-2 bg-surface p-4 text-left transition hover:border-accent", selected?.kind === "core" ? "border-accent" : "border-accent/40")}
            >
              <div className="flex items-center gap-2">
                <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-xl">{config.icon || "🤖"}</span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{agent.name}</span>
                  <span className="block text-xs text-muted">{locale === "uk" ? "Ядро агента" : "Ядро агента"}</span>
                </span>
              </div>
              <dl className="mt-3 space-y-1 text-xs">
                <Row k={locale === "uk" ? "Модель" : "Модель"} v={model} />
                <Row k={locale === "uk" ? "Тон" : "Тон"} v={t.builder.tones[config.tone]} />
                <Row k={locale === "uk" ? "Мова" : "Язык"} v={t.builder.languages[config.replyLanguage]} />
                <Row k={locale === "uk" ? "Роль" : "Роль"} v={config.role || "—"} />
              </dl>
            </button>

            {/* Модули */}
            <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(250px,1fr))]">
              {GROUPS.map((g) => (
                <div key={g.key} data-node={`grp-${g.key}`} className="min-w-0 rounded-2xl border border-border bg-surface p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <g.icon className={cx("size-4", groupOn(g.key) ? "text-accent" : "text-muted")} />
                    {tr(g.title)}
                  </div>
                  <div className="grid gap-1.5">
                    {MODULES.filter((m) => m.group === g.key).map((m) => {
                      const s = state(m);
                      const detail = m.detail?.(config, ctx);
                      return (
                        <div
                          key={m.key}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelected({ kind: "mod", key: m.key })}
                          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected({ kind: "mod", key: m.key })}
                          className={cx(
                            "flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition hover:border-accent/50",
                            selected?.kind === "mod" && selected.key === m.key ? "border-accent bg-accent-soft/40" : "border-border",
                            s === "off" && "text-muted",
                          )}
                        >
                          <Dot state={s} />
                          <m.icon className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{tr(m.title)}</span>
                          {detail && <span className="text-xs text-muted">{detail}</span>}
                          {m.toggle && <SwitchButton checked={m.on(config)} onChange={(v) => patch(m.toggle!(config, v))} label={tr(m.title)} />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Панель выбранного: выезжает справа поверх карты */}
        {selected && (
          <div role="dialog" className="fixed inset-y-0 right-0 z-40 w-full max-w-sm space-y-4 overflow-y-auto border-l border-border bg-surface p-5 shadow-2xl">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 font-semibold">{selected.kind === "core" ? (locale === "uk" ? "Ядро агента" : "Ядро агента") : current && tr(current.title)}</div>
              <button type="button" onClick={() => setSelected(null)} className="text-muted hover:text-text" aria-label="×">
                <X className="size-4" />
              </button>
            </div>
            {selected.kind === "core" ? (
              <CorePanel config={config} patch={patch} models={models} agentId={agent.id} locale={locale} />
            ) : (
              current && <ModulePanel m={current} config={config} patch={patch} ctx={ctx} locale={locale} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CorePanel({ config, patch, models, agentId, locale }: { config: AgentConfig; patch: (p: Partial<AgentConfig>) => void; models: { id: string; label: string }[]; agentId: string; locale: "ru" | "uk" }) {
  const { t } = useI18n();
  const list = models.some((m) => m.id === config.model) ? models : [{ id: config.model, label: config.model }, ...models];
  const uk = locale === "uk";
  return (
    <div className="space-y-3 text-sm">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{uk ? "Модель ШІ" : "Модель ИИ"}</span>
        <Select value={config.model} onChange={(e) => patch({ model: e.target.value })}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{uk ? "Глибина міркувань" : "Глубина размышлений"}</span>
        <Select value={config.effort} onChange={(e) => patch({ effort: e.target.value as AgentConfig["effort"] })}>
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {t.builder.efforts[x]}
            </option>
          ))}
        </Select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{uk ? "Тон" : "Тон"}</span>
        <Select value={config.tone} onChange={(e) => patch({ tone: e.target.value as AgentConfig["tone"] })}>
          {TONES.map((x) => (
            <option key={x} value={x}>
              {t.builder.tones[x]}
            </option>
          ))}
        </Select>
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">{uk ? "Мова відповідей" : "Язык ответов"}</span>
        <Select value={config.replyLanguage} onChange={(e) => patch({ replyLanguage: e.target.value as AgentConfig["replyLanguage"] })}>
          {REPLY_LANGUAGES.map((x) => (
            <option key={x} value={x}>
              {t.builder.languages[x]}
            </option>
          ))}
        </Select>
      </label>
      <Link href={`/agents/${agentId}#section-basics`} className="inline-flex items-center gap-1 text-accent hover:underline">
        {uk ? "Роль, правила й інструкції" : "Роль, правила и инструкции"}
        <ExternalLink className="size-3.5" />
      </Link>
    </div>
  );
}

function ModulePanel({ m, config, patch, ctx, locale }: { m: Mod; config: AgentConfig; patch: (p: Partial<AgentConfig>) => void; ctx: Ctx; locale: "ru" | "uk" }) {
  const uk = locale === "uk";
  const warn = m.on(config) ? m.warn?.(config, ctx) : null;
  const items = m.pick ? ctx.lists[m.pick.list] : m.key === "kb" ? ctx.lists.kb : m.key === "loyalty" ? ctx.lists.programs : [];
  const selectedIds: string[] = m.pick ? (config[m.pick.field] ?? []) : [];
  const setPick = (id: string, on: boolean) => {
    if (!m.pick) return;
    const next = on ? [...selectedIds, id] : selectedIds.filter((x) => x !== id);
    patch({ [m.pick.field]: next } as Partial<AgentConfig>);
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">{m.desc[locale]}</p>
      {warn && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">{warn[locale]}</p>}
      {m.toggle && (
        <div className="flex items-center gap-3">
          <span className="flex-1 font-medium">{m.on(config) ? (uk ? "Увімкнено" : "Включено") : uk ? "Вимкнено" : "Выключено"}</span>
          <SwitchButton checked={m.on(config)} onChange={(v) => patch(m.toggle!(config, v))} />
        </div>
      )}

      {m.key === "factGuard" && m.on(config) && (
        <Select value={config.factGuard} onChange={(e) => patch({ factGuard: e.target.value as AgentConfig["factGuard"] })}>
          <option value="flag">{uk ? "Позначати в «Діалогах»" : "Помечать в «Диалогах»"}</option>
          <option value="block">{uk ? "Не надсилати, а на погодження" : "Не отправлять, а на одобрение"}</option>
        </Select>
      )}
      {m.key === "budget" && m.on(config) && (
        <label className="flex items-center gap-2">
          <span className="text-muted">$</span>
          <Input type="number" min={0} step="1" value={config.monthlyBudgetUsd ?? 0} onChange={(e) => patch({ monthlyBudgetUsd: Math.max(0, Number(e.target.value)) })} />
          <span className="shrink-0 text-muted">{uk ? "на місяць" : "в месяц"}</span>
        </label>
      )}

      {m.key === "kb" && (
        <div className="space-y-1.5">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={config.kbSourceIds === null} onChange={(e) => patch({ kbSourceIds: e.target.checked ? null : items.map((i) => i.id) })} />
            <span className="font-medium">{uk ? "Усі джерела клієнта" : "Все источники клиента"}</span>
          </label>
          {config.kbSourceIds !== null &&
            items.map((i) => (
              <label key={i.id} className="flex items-center gap-2 pl-6">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={config.kbSourceIds!.includes(i.id)}
                  onChange={(e) => patch({ kbSourceIds: e.target.checked ? [...config.kbSourceIds!, i.id] : config.kbSourceIds!.filter((x) => x !== i.id) })}
                />
                <span className="truncate">{i.name}</span>
              </label>
            ))}
        </div>
      )}

      {m.key === "loyalty" && (
        <Select value={config.loyaltyProgramId ?? ""} onChange={(e) => patch({ loyaltyProgramId: e.target.value || null })}>
          <option value="">{uk ? "Без програми балів" : "Без программы баллов"}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      )}

      {m.pick &&
        (items.length === 0 ? (
          <p className="text-muted">{uk ? "У клієнта поки нічого немає — створіть у повних налаштуваннях." : "У клиента пока ничего нет — создайте в полных настройках."}</p>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {items.map((i) => (
              <label key={i.id} className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={selectedIds.includes(i.id)} onChange={(e) => setPick(i.id, e.target.checked)} />
                <span className="truncate">{i.name}</span>
              </label>
            ))}
          </div>
        ))}

      <Link href={m.href(ctx)} className="inline-flex items-center gap-1 text-accent hover:underline">
        {uk ? "Повні налаштування" : "Полные настройки"}
        <ExternalLink className="size-3.5" />
      </Link>
    </div>
  );
}

function Dot({ state }: { state: "on" | "off" | "warn" }) {
  return <span className={cx("size-2 shrink-0 rounded-full", state === "on" ? "bg-success" : state === "warn" ? "bg-amber-500" : "bg-muted/30")} />;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0 truncate font-medium">{v}</dd>
    </div>
  );
}

function ColumnTitle({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted">
      <Icon className="size-3.5" />
      {text}
    </div>
  );
}

function Legend({ locale }: { locale: "ru" | "uk" }) {
  const uk = locale === "uk";
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <Dot state="on" />
        {uk ? "увімкнено" : "включён"}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot state="warn" />
        {uk ? "чогось бракує" : "чего-то не хватает"}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot state="off" />
        {uk ? "вимкнено" : "выключен"}
      </span>
      <Badge>{uk ? "збереження — нова версія" : "сохранение — новая версия"}</Badge>
    </div>
  );
}

/** Линии схемы: от каналов к ядру и от ядра к группам модулей (только на широком экране). */
function useLines(root: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [paths, setPaths] = useState<{ id: string; d: string; active: boolean }[]>([]);
  const key = JSON.stringify(deps);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      if (!window.matchMedia("(min-width: 1024px)").matches) return setPaths([]);
      const box = el.getBoundingClientRect();
      const rect = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { l: r.left - box.left, r: r.right - box.left, y: r.top - box.top + r.height / 2 };
      };
      const core = el.querySelector('[data-node="core"]');
      if (!core) return;
      const c = rect(core);
      const curve = (x1: number, y1: number, x2: number, y2: number) => {
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
      };
      const out: { id: string; d: string; active: boolean }[] = [];
      el.querySelectorAll('[data-node^="ch-"]').forEach((n) => {
        const r = rect(n);
        out.push({ id: n.getAttribute("data-node")!, d: curve(r.r, r.y, c.l, c.y), active: n.querySelector(".bg-success") !== null });
      });
      el.querySelectorAll('[data-node^="grp-"]').forEach((n) => {
        const r = rect(n);
        out.push({ id: n.getAttribute("data-node")!, d: curve(c.r, c.y, r.l, r.y), active: n.querySelector(".bg-success, .bg-amber-500") !== null });
      });
      setPaths(out);
    };
    // Раскладка и шрифты устанавливаются не сразу — меряем ещё раз чуть позже
    const frame = requestAnimationFrame(measure);
    const later = setTimeout(measure, 400);
    void document.fonts?.ready.then(measure);
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [root, key]);
  return paths;
}
