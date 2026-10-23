/** События, которые можно отправлять во внешние системы (общий список для сервера и интерфейса) */
export const INTEGRATION_EVENTS = ["lead", "handoff", "booking", "rating", "bot_event", "form", "document", "meeting", "points"] as const;
export type IntegrationEventType = (typeof INTEGRATION_EVENTS)[number];
