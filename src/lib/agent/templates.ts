import { DEFAULT_MODEL } from "@/lib/models";
import { calendarConfigSchema, type AgentConfig, type Localized } from "./types";

export type TemplateCategory = "sales" | "support" | "booking" | "social";

export type AgentTemplate = {
  key: string;
  icon: string;
  category: TemplateCategory;
  name: Localized;
  description: Localized;
  config: Partial<AgentConfig>;
};

export function emptyConfig(): AgentConfig {
  return {
    icon: "🤖",
    role: "",
    description: "",
    model: DEFAULT_MODEL,
    effort: "low",
    tone: "friendly",
    toneCustom: "",
    replyLanguage: "auto",
    skills: [],
    knowledge: "",
    kbSourceIds: null,
    factGuard: "flag",
    monthlyBudgetUsd: null,
    rules: "",
    handoff: "",
    greeting: "",
    extraInstructions: "",
    useBrandVoice: true,
    calendar: calendarConfigSchema.parse({}),
  };
}

export const TEMPLATES: AgentTemplate[] = [
  {
    key: "shop_consultant",
    icon: "🛍️",
    category: "sales",
    name: { ru: "Консультант магазина", uk: "Консультант магазину" },
    description: {
      ru: "Подбирает товар, отвечает про цены и наличие, работает с возражениями",
      uk: "Підбирає товар, відповідає про ціни та наявність, працює із запереченнями",
    },
    config: {
      role: "консультант интернет-магазина",
      description:
        "Помогай клиентам выбрать товар под их задачу, отвечай на вопросы о ценах, наличии, доставке и оплате. Цель — довести клиента до заказа или передать тёплый контакт менеджеру.",
      skills: ["consult_products", "objections", "upsell", "collect_contacts"],
      greeting: "Здравствуйте! Подскажу с выбором — что ищете?",
    },
  },
  {
    key: "lead_qualifier",
    icon: "🎯",
    category: "sales",
    name: { ru: "Квалификатор лидов", uk: "Кваліфікатор лідів" },
    description: {
      ru: "Выясняет задачу, бюджет и сроки, передаёт в продажи только целевых",
      uk: "З'ясовує задачу, бюджет і терміни, передає в продажі лише цільових",
    },
    config: {
      role: "менеджер по первичной работе с заявками",
      description:
        "Твоя задача — понять, насколько клиент целевой: что ему нужно, какой бюджет, сроки и кто принимает решение. Целевых клиентов передавай менеджеру с кратким резюме.",
      skills: ["lead_qualification", "collect_contacts", "objections"],
      tone: "formal",
      greeting: "Добрый день! Расскажите, пожалуйста, какую задачу хотите решить?",
    },
  },
  {
    key: "booking_admin",
    icon: "📅",
    category: "booking",
    name: { ru: "Администратор записи", uk: "Адміністратор запису" },
    description: {
      ru: "Записывает в салон, клинику или студию, отвечает про услуги и цены",
      uk: "Записує до салону, клініки чи студії, відповідає про послуги та ціни",
    },
    config: {
      role: "администратор",
      description:
        "Отвечай на вопросы об услугах, ценах и специалистах, помогай выбрать услугу и записывай клиентов на удобное время.",
      skills: ["booking", "faq_support", "consult_products"],
      greeting: "Здравствуйте! Хотите записаться или подсказать по услугам?",
    },
  },
  {
    key: "support_base",
    icon: "📚",
    category: "support",
    name: { ru: "Поддержка по базе знаний", uk: "Підтримка за базою знань" },
    description: {
      ru: "Отвечает на частые вопросы, помогает с заказами и оплатой",
      uk: "Відповідає на часті запитання, допомагає із замовленнями та оплатою",
    },
    config: {
      role: "специалист службы поддержки",
      description:
        "Помогай клиентам решать вопросы по заказам, оплате, доставке и возвратам, опираясь на базу знаний.",
      skills: ["faq_support", "order_status"],
      tone: "formal",
      greeting: "Здравствуйте! Чем могу помочь?",
    },
  },
  {
    key: "online_school",
    icon: "🎓",
    category: "sales",
    name: { ru: "Менеджер онлайн-школы", uk: "Менеджер онлайн-школи" },
    description: {
      ru: "Помогает выбрать курс, рассказывает о программе и ведёт к оплате",
      uk: "Допомагає обрати курс, розповідає про програму та веде до оплати",
    },
    config: {
      role: "менеджер онлайн-школы",
      description:
        "Узнай цель и уровень ученика, порекомендуй подходящий курс или тариф, расскажи о программе, формате и результатах. Веди к записи на курс.",
      skills: ["lead_qualification", "consult_products", "objections", "collect_contacts"],
      greeting: "Привет! Помогу подобрать курс. Чему хотите научиться?",
    },
  },
  {
    key: "community_manager",
    icon: "📣",
    category: "social",
    name: { ru: "Комьюнити-менеджер", uk: "Комʼюніті-менеджер" },
    description: {
      ru: "Отвечает на комментарии и директ в Instagram и Threads",
      uk: "Відповідає на коментарі та директ в Instagram і Threads",
    },
    config: {
      role: "комьюнити-менеджер бренда в соцсетях",
      description:
        "Отвечай на комментарии и сообщения подписчиков: благодари, отвечай на вопросы, переводи заинтересованных в личные сообщения.",
      skills: ["social_comments", "faq_support", "collect_contacts"],
      tone: "playful",
    },
  },
  {
    key: "feedback_collector",
    icon: "⭐",
    category: "support",
    name: { ru: "Сбор отзывов", uk: "Збір відгуків" },
    description: {
      ru: "Собирает впечатления после покупки и ловит недовольных",
      uk: "Збирає враження після покупки та ловить незадоволених",
    },
    config: {
      role: "специалист по качеству сервиса",
      description:
        "Узнавай у клиентов впечатления от покупки или услуги, собирай оценку и предложения. Недовольных клиентов сразу передавай менеджеру.",
      skills: ["feedback"],
      greeting: "Здравствуйте! Подскажите, как вам наш сервис?",
    },
  },
];

export const TEMPLATE_MAP = new Map(TEMPLATES.map((t) => [t.key, t]));

export function configFromTemplate(key: string | null | undefined): AgentConfig {
  const t = key ? TEMPLATE_MAP.get(key) : undefined;
  return { ...emptyConfig(), ...(t ? { icon: t.icon, ...t.config } : {}) };
}
