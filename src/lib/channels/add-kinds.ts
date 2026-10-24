/** Каналы, которые подключаются формой на странице «Каналы» агента (ссылка ?add=… открывает форму сразу). */
export const ADD_KINDS = ["telegram", "instagram", "threads", "email", "api", "whatsapp", "viber", "voice", "messenger", "sms"] as const;
export type AddKind = (typeof ADD_KINDS)[number];
