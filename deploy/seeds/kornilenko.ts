/**
 * Клиент «Construcciones Kornilenko» — застройщик на Коста-Бланке: база знаний и консультант для его Telegram-бота.
 * Факты берутся из данных бота (объекты, гиды, план покупки, контакты, калькулятор) — без клиентов и ключей.
 *   npx tsx deploy/seeds/kornilenko.ts <выгрузка-данных-бота.json> > payload.json
 * Выгрузка: только публичные поля bot-data.json (objects, contacts, guidePages, buyPlan, menu, calculator, workingHours).
 */
import { readFileSync } from "node:fs";
import { chunkText } from "../../src/lib/kb/text";
import { calendarConfigSchema, type AgentConfig } from "../../src/lib/agent/types";

type Loc = Record<string, string | undefined>;
type BotObject = {
  title: Loc;
  reference: string;
  url: string;
  status: string;
  priceValue: number | null;
  currency: string;
  priceFrom: boolean;
  dealType: string;
  propertyType: string;
  city: Loc;
  district: Loc;
  bedrooms: number | null;
  bathrooms: number | null;
  area: number | null;
  plotArea: number | null;
  floor: string;
  distanceSea: number | null;
  condition: string;
  address: Loc;
  description: Loc;
};
type BotData = {
  objects: BotObject[];
  contacts: { managerName: string; phone: string; telegram: string; email: string; website: string; mapUrl: string; whatsappEnabled: boolean };
  guidePages: { title: Loc; text?: Loc; body?: Loc }[];
  buyPlan: { title: Loc; text?: Loc; description?: Loc }[];
  menu: Record<string, { about?: string }>;
  calculator: { enabled: boolean; resaleTaxPercent: number; newBuildTaxPercent: number; businessTaxPercent: number; stampDutyPercent: number; otherCostsPercent: number; downPaymentPercent: number; interestPercent: number; years: number };
};

const data = JSON.parse(readFileSync(process.argv[2], "utf8")) as BotData;
const ru = (v?: Loc) => (v?.ru ?? v?.en ?? "").trim();
const CONDITION: Record<string, string> = { under_construction: "строится", renovated: "после ремонта", new: "новый", resale: "вторичка" };
const TYPE: Record<string, string> = { apartment: "апартаменты", villa: "вилла", house: "дом", townhouse: "таунхаус", penthouse: "пентхаус" };
const money = (n: number | null, cur: string) => (n ? `${n.toLocaleString("ru-RU").replace(/ /g, " ")} ${cur === "EUR" ? "€" : cur}` : "по запросу");

const objects = data.objects
  .filter((o) => o.status === "active")
  .map((o) => {
    const names = ["en", "es"].map((l) => o.title[l]).filter(Boolean).join(" / ");
    const facts = [
      `Код объекта: ${o.reference}`,
      `Цена: ${o.priceFrom ? "от " : ""}${money(o.priceValue, o.currency)}`,
      `Тип: ${TYPE[o.propertyType] ?? o.propertyType}, ${o.dealType === "rent" ? "аренда" : "продажа"}, ${CONDITION[o.condition] ?? o.condition}`,
      `Где: ${[ru(o.city), ru(o.district)].filter(Boolean).join(", ")}${ru(o.address) ? ` (адрес: ${ru(o.address)})` : ""}`,
      o.bedrooms ? `Спальни: ${o.priceFrom ? "от " : ""}${o.bedrooms}` : "",
      o.bathrooms ? `Санузлы: ${o.bathrooms}` : "",
      o.area ? `Площадь: ${o.priceFrom ? "от " : ""}${o.area} м²` : "",
      o.plotArea ? `Участок: ${o.plotArea} м²` : "",
      o.floor ? `Этаж: ${o.floor}` : "",
      o.distanceSea ? `До моря: ~${(o.distanceSea / 1000).toFixed(1).replace(".0", "")} км` : "",
      o.url ? `Сайт проекта: ${o.url}` : "",
    ].filter(Boolean);
    return `## ${ru(o.title)}${names ? ` (${names})` : ""}\n${facts.join("\n")}\n\n${ru(o.description)}`;
  });

const c = data.contacts;
const calc = data.calculator;
const about = (data.menu.ru?.about ?? "").trim();

// key — те же ключи, что у бота (src/ai-knowledge.mjs): дальше эти документы обновляет он сам.
const docs = [
  {
    key: "objects",
    title: "Объекты в продаже",
    content: `# Объекты Construcciones Kornilenko\nВсе объекты — на Коста-Бланке (провинция Аликанте, Испания). Цены и наличие ориентировочные, актуальные подтверждает менеджер. В боте у каждого объекта есть карточка с фото, калькулятором расходов и записью на просмотр.\n\n${objects.join("\n\n")}`,
  },
  {
    key: "company",
    title: "О компании и контакты",
    content: `# О компании\n${about}\n\n# Контакты\n- Менеджер: ${c.managerName}\n- Телефон${c.whatsappEnabled ? " / WhatsApp" : ""}: ${c.phone}\n- Telegram: ${c.telegram}\n- Email: ${c.email}\n- Сайт: ${c.website}\n- Офис: Carrer Benifato 10, local 11, 03509 Finestrat (Alicante), карта: ${c.mapUrl}\n- Время работы менеджера: пн–пт 09:00–19:00 (Испания, Europe/Madrid)`,
  },
  {
    key: "guides",
    title: "Как купить недвижимость в Испании",
    content: `# Гиды по покупке\n${data.guidePages.map((g) => `## ${ru(g.title)}\n${ru(g.text ?? g.body)}`).join("\n\n")}\n\n# План покупки по шагам\n${data.buyPlan.map((s, i) => `${i + 1}. ${ru(s.title)} — ${ru(s.text ?? s.description)}`).join("\n")}`,
  },
  {
    key: "costs",
    title: "Расходы на покупку и ипотека",
    content: `# Расходы сверх цены объекта (как считает калькулятор бота)\n- Новостройка: IVA ${calc.newBuildTaxPercent}% и гербовый сбор (AJD) ${calc.stampDutyPercent}%\n- Вторичное жильё: налог ITP ${calc.resaleTaxPercent}%\n- Коммерческая недвижимость: IVA ${calc.businessTaxPercent}%\n- Нотариус, регистрация, оформление: около ${calc.otherCostsPercent}%\n- В сумме обычно закладывают 10–14% сверх цены.\n\n# Ипотека в калькуляторе (пример, не предложение банка)\n- Первый взнос: ${calc.downPaymentPercent}% (нерезидентам банки обычно дают до 60–70% стоимости)\n- Ставка: ${calc.interestPercent}% годовых, срок: ${calc.years} лет\n- Точный расчёт по объекту — кнопка калькулятора в карточке объекта в боте; условия банка подтверждает сам банк.`,
  },
];

const config: AgentConfig = {
  icon: "🏗️",
  role: "консультант по недвижимости застройщика Construcciones Kornilenko",
  description:
    "Отвечай на вопросы клиентов бота о наших объектах на Коста-Бланке, ценах, условиях оплаты, расходах на покупку, ипотеке для нерезидентов и этапах сделки в Испании. Помоги клиенту понять, какой объект ему подходит (цель: жить, сдавать, инвестировать; бюджет; спальни; близость к морю). Веди к следующему шагу: посмотреть карточку объекта в каталоге бота, посчитать расходы в калькуляторе, записаться на просмотр или связаться с менеджером.",
  model: "anthropic:claude-haiku-5-5",
  effort: "low",
  tone: "custom",
  toneCustom: "Вежливо, по-деловому и тепло, на «вы». Коротко и по делу, как опытный менеджер по продажам недвижимости. Без давления и восклицаний.",
  replyLanguage: "auto",
  skills: ["consult_products", "lead_qualification", "objections", "faq_support"],
  knowledge: [
    "Компания: Construcciones Kornilenko — строительство и продажа недвижимости на Коста-Бланке (Финестрат, Релеу, Бенидорм).",
    "Объекты: Riviera 1 (Финестрат, туристические апартаменты, от 147 312 €), Riviera Relleu (Релеу, от 95 000 €), Sierra Verde (Финестрат, виллы с бассейном, от 550 000 €), дуплекс 150 м² в центре Бенидорма (1 100 000 €).",
    "Цены и наличие ориентировочные — точные подтверждает менеджер.",
  ].join("\n"),
  kbSourceIds: null,
  rules: [
    "Не называй объекты, цены, сроки сдачи, скидки и условия, которых нет в базе знаний. Цены ориентировочные — говори, что точную цену и наличие подтверждает менеджер.",
    "Доходность от аренды — оценка застройщика, а не гарантия: всегда так и говори.",
    "Riviera 1 — для краткосрочной аренды, не для постоянного проживания.",
    "Sierra Verde: виллы №2 и №4 проданы.",
    "Налоги и ипотека — только общие сведения из базы знаний; для своей ситуации советуй независимого юриста и банк. Не давай юридических и налоговых гарантий.",
    "Советуй кнопки бота: «Каталог» с карточками объектов, «Подбор», калькулятор расходов в карточке, «Записаться на просмотр», «Связаться с менеджером».",
  ].join("\n"),
  handoff:
    "клиент хочет записаться на просмотр (лично или по видео), зарезервировать объект, узнать точное наличие или торговаться о цене; просит позвонить ему или оставляет телефон; хочет оформить ипотеку или юридическое сопровождение; недоволен или просит живого менеджера",
  greeting: "",
  extraInstructions: "",
  useBrandVoice: true,
  factGuard: "flag",
  monthlyBudgetUsd: 30,
  memory: true,
  voiceReplies: true,
  voice: "marin",
  qualityCheck: true,
  calendar: calendarConfigSchema.parse({}),
};

const payload = {
  client: {
    name: "Construcciones Kornilenko",
    industry: "Строительство и продажа недвижимости в Испании (Коста-Бланка)",
    website: c.website,
    description:
      "Застройщик и строительная компания в Финестрате (Аликанте, Испания): новостройки — апартаменты и виллы на Коста-Бланке, строительство, ремонт и обслуживание недвижимости, энергоэффективность классов A и B, многоязычное юридическое сопровождение сделок.",
    brandVoice: "Профессионально и надёжно, без пафоса. Прозрачные условия, забота о клиенте на каждом этапе сделки.",
    color: "#0ea5e9",
  },
  agent: { name: "Консультант по недвижимости", config },
  sources: docs.map((d) => ({ key: d.key, title: d.title, content: d.content, chunks: chunkText(d.content, d.title) })),
};
process.stdout.write(JSON.stringify(payload));
