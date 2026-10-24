/**
 * Раскрытие ИИ (EU AI Act, ст. 50, с 02.08.2026): человек должен узнать, что общается с ИИ, не позднее первого
 * взаимодействия, ясно и прямо в диалоге, с названием компании. Первая строка первого ответа агента в разговоре.
 */
const DEFAULTS: Record<"ru" | "uk" | "en", string> = {
  ru: "🤖 Вас приветствует ИИ-ассистент компании «{company}». Если нужен живой сотрудник — просто напишите об этом.",
  uk: "🤖 Вас вітає ШІ-асистент компанії «{company}». Якщо потрібен живий співробітник — просто напишіть про це.",
  en: "🤖 You are chatting with an AI assistant of {company}. If you need a person, just say so.",
};

/** Язык строки: язык разговора (если известен), иначе язык ответов агента, иначе русский. */
export function disclosureLanguage(conversationLanguage: string | undefined, replyLanguage: string | undefined): "ru" | "uk" | "en" {
  const pick = (l?: string) => (l === "uk" || l === "ua" ? "uk" : l === "en" ? "en" : l === "ru" ? "ru" : null);
  return pick(conversationLanguage?.slice(0, 2).toLowerCase()) ?? pick(replyLanguage) ?? "ru";
}

export function disclosureText(company: string, lang: "ru" | "uk" | "en", custom = "") {
  return (custom.trim() || DEFAULTS[lang]).replaceAll("{company}", company.trim() || "—");
}

export const DISCLOSURE_DEFAULTS = DEFAULTS;
