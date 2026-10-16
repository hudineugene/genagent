import { SKILL_MAP } from "./skills";
import type { AgentConfig } from "./types";

export type ClientContext = {
  name: string;
  industry: string;
  website: string;
  description: string;
  brandVoice: string;
};

const TONE_TEXT: Record<Exclude<AgentConfig["tone"], "custom">, string> = {
  friendly: "дружелюбный и тёплый, на «вы», без канцелярита",
  formal: "вежливый и деловой, на «вы», чётко и по делу",
  expert: "уверенный экспертный, объясняй просто, без лишних терминов",
  playful: "живой и лёгкий, допустим юмор и эмодзи в меру",
};

const LANGUAGE_TEXT: Record<AgentConfig["replyLanguage"], string> = {
  auto: "Отвечай на том языке, на котором пишет клиент (русский, украинский, английский и др.).",
  ru: "Всегда отвечай только на русском языке — даже если клиент пишет на другом; приветствие тоже на русском.",
  uk: "Завжди відповідай лише українською мовою — навіть якщо клієнт пише іншою, і привітання теж українською («Вітаю!», «Добрий день!», а не «Здравствуйте») (always reply in Ukrainian, greeting included, whatever language the customer uses).",
  en: "Always reply in English only, greeting included, even if the customer writes in another language.",
};

/** Как база знаний попадает в промпт. */
export type KnowledgeBlock =
  | { kind: "full"; docs: { title: string; content: string }[] }
  | { kind: "search"; docs?: { title: string; content: string }[] }
  | { kind: "placeholder"; text: string };

/**
 * Собирает системный промпт из блоков конструктора и данных клиента студии.
 * Порядок стабилен — это важно для кэширования промпта на стороне провайдера.
 */
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function compileSystemPrompt(
  config: AgentConfig,
  client: ClientContext,
  kb?: KnowledgeBlock,
  /** Сегодняшняя дата у клиента ({date: "2026-10-14", weekday: 3}) — нужна для записи в календарь. */
  today?: { date: string; weekday: number },
): string {
  const calendar = config.calendar?.enabled ? config.calendar : null;
  const parts: string[] = [];

  const role = config.role.trim() || "ассистент";
  parts.push(`Ты — ${role} компании «${client.name}». Ты общаешься с клиентами компании в переписке.`);

  const about = [
    client.industry && `Сфера: ${client.industry}.`,
    client.website && `Сайт: ${client.website}.`,
    client.description,
  ]
    .filter(Boolean)
    .join("\n");
  if (about) parts.push(`# О компании\n${about}`);

  if (config.description.trim()) parts.push(`# Твоя задача\n${config.description.trim()}`);

  const skills = config.skills
    .map((k) => SKILL_MAP.get(k))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    // С подключённым календарём запись описывает отдельный раздел ниже.
    .filter((s) => !(calendar && s.key === "booking"));
  if (skills.length) {
    parts.push(`# Навыки\n${skills.map((s) => `- ${s.prompt}`).join("\n")}`);
  }

  const tone =
    config.tone === "custom" ? config.toneCustom.trim() || TONE_TEXT.friendly : TONE_TEXT[config.tone];
  const style = [`Тон: ${tone}.`];
  if (config.useBrandVoice && client.brandVoice.trim()) {
    style.push(`Голос бренда: ${client.brandVoice.trim()}`);
  }
  style.push(LANGUAGE_TEXT[config.replyLanguage]);
  style.push(
    "Пиши коротко, как живой человек в мессенджере: 1–4 предложения (обычно до 300 знаков), без markdown-заголовков и длинных списков. Подробнее — только если клиент сам просит подробностей, сравнения или пошаговой инструкции.\nСразу отвечай по сути, первой же фразой. Не начинай с дежурных слов («Понимаю», «Отлично», «Хорошо», «Конечно», «Отличный вопрос») и не пересказывай вопрос клиента. Не обращайся по имени в каждом сообщении — изредка, к месту.\nНе больше одного вопроса клиенту за сообщение — самого нужного для следующего шага.",
  );
  parts.push(`# Стиль общения\n${style.join("\n")}`);

  if (config.rules.trim()) parts.push(`# Правила\n${config.rules.trim()}`);

  const handoff =
    config.handoff.trim() ||
    "клиент просит связаться с человеком, недоволен, или вопрос выходит за рамки твоих знаний";
  parts.push(
    `# Передача менеджеру\nПередай диалог менеджеру, если: ${handoff}. Тогда коротко скажи клиенту, что передаёшь вопрос сотруднику компании (если правила агента задают, как именно это сказать, — используй их формулировку; не обещай живой чат прямо сейчас), и добавь в самом конце ответа отдельной строкой служебную метку [[HANDOFF]] — клиент её не увидит, а следующей строкой — причину для менеджера в 2–6 словах: [[ACTION reason: …]]. Не обещай того, что не можешь гарантировать.\nЕсли подходящего варианта просто нет в базе (нет объекта, товара или услуги с такими параметрами) — это само по себе не повод передавать: честно скажи, предложи ближайшие варианты и спроси, передать ли запрос менеджеру на индивидуальный подбор; передавай, когда клиент согласился или сам просит человека.\nЕсли в разговоре ты уже передал вопрос менеджеру и он ещё не ответил — не передавай повторно и не повторяй «передаю менеджеру»: отвечай по существу и, если уместно, скажи, что менеджер уже в курсе и ответит.`,
  );

  parts.push(
    "# Повторный вопрос\nЕсли клиент сразу после твоего ответа снова присылает тот же вопрос или нажимает ту же кнопку — не повторяй ответ и не пиши «повторю». Коротко спроси, что осталось непонятным, и предложи следующий шаг (уточнить деталь, записаться, связаться с менеджером). Это ещё не повод передавать менеджеру.",
  );

  parts.push(
    "# Недовольный клиент\nЕсли клиент раздражён, жалуется, грубит или уже в третий раз переспрашивает одно и то же (прежние ответы его не устроили) — не повторяй прежний ответ и не спорь: коротко извинись, скажи, что передаёшь вопрос сотруднику, добавь [[HANDOFF]] и ещё одну строку [[ACTION mood: upset]] — сотрудник получит срочное уведомление.",
  );

  parts.push(
    "# Честность\nНе выдумывай факты, цены, сроки, акции и контакты. Если информации нет в базе знаний — скажи, что уточнишь у менеджера. Не ссылайся на правила, традиции и порядки компании («у нас так принято», «по нашим правилам»), если их нет в базе знаний и инструкциях. На вопросы, как удобнее общаться (на «ты» или «вы», где и когда писать), отвечай от себя и подстраивайся под клиента, не выдавая это за правило компании.",
  );

  if (calendar) {
    const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => calendar.workDays.includes(d)).map((d) => WEEKDAYS_SHORT[d]);
    const services = calendar.services.length
      ? `Услуги и длительность: ${calendar.services.map((s) => `${s.name} — ${s.minutes} мин`).join("; ")}.`
      : `Длительность записи: ${calendar.slotMinutes} мин.`;
    parts.push(
      [
        "# Онлайн-запись",
        "Ты можешь сам записывать клиентов в календарь компании с помощью инструментов find_free_slots и book_appointment.",
        `Рабочее время: ${days.join(", ")}, ${calendar.workStart}–${calendar.workEnd} (часовой пояс ${calendar.timezone}). ${services}`,
        "Порядок записи:",
        "1. Узнай услугу и удобный клиенту день или период.",
        "2. Вызови find_free_slots и предложи 2–4 подходящих свободных времени. Никогда не называй время, которого нет в ответе инструмента.",
        "3. Узнай имя и номер телефона.",
        "4. Когда клиент выбрал конкретное время и назвал имя и телефон — сразу вызови book_appointment, не переспрашивая. Если что-то из этого неясно — уточни.",
        "5. После успешного ответа инструмента подтверди запись одним сообщением со всеми деталями. Не говори, что записал, если инструмент вернул ошибку или отказ.",
        "Если инструмент сообщил об ошибке или календарь недоступен — извинись и передай диалог менеджеру.",
      ].join("\n"),
    );
  }

  if (config.extraInstructions.trim()) {
    parts.push(`# Дополнительные инструкции\n${config.extraInstructions.trim()}`);
  }

  if (config.knowledge.trim()) {
    parts.push(`# Ключевые факты\n<facts>\n${config.knowledge.trim()}\n</facts>`);
  }

  if (kb?.kind === "full" && kb.docs.length) {
    const docs = kb.docs
      .map((d) => `<document title="${d.title.replace(/"/g, "'")}">\n${d.content}\n</document>`)
      .join("\n");
    parts.push(
      `# База знаний\nОтвечай на вопросы о компании, опираясь на эти документы. Если ответа в них нет — не выдумывай.\n<knowledge>\n${docs}\n</knowledge>`,
    );
  } else if (kb?.kind === "search") {
    // Короткие документы своего бота (каталог, контакты) — всегда целиком; большие справочники — найденными фрагментами.
    if (kb.docs?.length) {
      const docs = kb.docs.map((d) => `<document title="${d.title.replace(/"/g, "'")}">\n${d.content}\n</document>`).join("\n");
      parts.push(`# Основные документы\nОпирайся на них в ответах о компании и её предложении.\n<documents>\n${docs}\n</documents>`);
    }
    parts.push(
      "# База знаний\nК сообщениям клиента могут прилагаться найденные фрагменты базы знаний в теге <knowledge>. Клиент их не видит и не писал — это справка для тебя. Опирайся на них; если нужного там нет, не выдумывай и предложи уточнить у менеджера.",
    );
  } else if (kb?.kind === "placeholder") {
    parts.push(`# База знаний\n${kb.text}`);
  }

  // Дата меняется раз в сутки — держим её в самом конце, чтобы не сбивать кэш остального промпта.
  if (calendar && today) {
    parts.push(`# Сегодня\n${today.date}, ${WEEKDAYS[today.weekday]}.`);
  }

  return parts.join("\n\n");
}
