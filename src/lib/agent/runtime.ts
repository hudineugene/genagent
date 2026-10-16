import "server-only";
import { compileSystemPrompt, type ClientContext } from "./compile";
import type { AgentConfig } from "./types";
import { loadKnowledge } from "@/lib/kb/store";
import type { AgentTool, ChatMessage } from "@/lib/llm";
import { utcToZoned } from "@/lib/google/calendar";
import { calendarTools, type ToolContext } from "./tools";
import { examplesNote, getExamples } from "./examples";

export const HANDOFF_MARKER = "[[HANDOFF]]";

export type KbInfo = { mode: "full" | "search"; sources: { title: string; url: string | null }[] } | null;

/**
 * Готовит запрос к модели: системный промпт с базой знаний и история диалога.
 * История должна начинаться с сообщения клиента; найденные фрагменты базы знаний
 * в режиме поиска прикладываются к последнему сообщению клиента.
 */
export async function prepareChat(
  config: AgentConfig,
  client: ClientContext & { id: string },
  history: ChatMessage[],
  /** Режим инструментов: live — настоящий канал, dry — тест-чат и автотесты (без записи в календарь). */
  tools: Omit<ToolContext, "clientId"> = { mode: "dry" },
  /** Особенности канала (например, формат письма) — в конец системного промпта. */
  channelNote?: string,
): Promise<{ system: string; messages: ChatMessage[]; kb: KbInfo; tools?: AgentTool[] }> {
  // Модель требует, чтобы диалог начинался с клиента: приветствие агента отбрасываем.
  const start = history.findIndex((m) => m.role === "user");
  const messages = start < 0 ? [] : history.slice(start).map((m) => ({ ...m }));

  const kb = await loadKnowledge(
    client.id,
    config.kbSourceIds,
    messages.filter((m) => m.role === "user").map((m) => m.content),
  );
  const system = compileSystemPrompt(
    config,
    client,
    kb.mode === "full" ? { kind: "full", docs: kb.docs } : kb.mode === "search" ? { kind: "search", docs: kb.pinned } : undefined,
    config.calendar.enabled ? utcToZoned(new Date(), config.calendar.timezone) : undefined,
  );
  // Удачные ответы этого агента — образец стиля (обновляются раз в сутки)
  const examples = tools.agentId ? examplesNote(await getExamples(tools.agentId).catch(() => [])) : undefined;
  const fullSystem = [system, examples, channelNote].filter(Boolean).join("\n\n");
  const agentTools = config.calendar.enabled ? calendarTools(config.calendar, { ...tools, clientId: client.id }) : undefined;

  const last = messages[messages.length - 1];
  if (kb.mode === "search" && kb.context && last?.role === "user") {
    last.content = `<knowledge>\n${kb.context}\n</knowledge>\n\n${last.content}`;
  }
  // Агент знает, какой сейчас день и час у компании: «вы сейчас открыты?», «успею сегодня?»
  if (last?.role === "user") last.content = `${nowLine(config.calendar.timezone)}\n\n${last.content}`;

  const kbInfo: KbInfo =
    kb.mode === "none"
      ? null
      : {
          mode: kb.mode,
          sources: (kb.mode === "full" ? kb.sources : kb.used).map(({ title, url }) => ({ title, url })),
        };
  return { system: fullSystem, messages, kb: kbInfo, tools: agentTools };
}

/** «[Сейчас у компании: четверг, 15 октября 2026, 21:40 (Europe/Kyiv)]» — служебная строка для агента. */
export function nowLine(timezone: string | undefined, at = new Date()) {
  const tz = timezone || "Europe/Kyiv";
  let when: string;
  try {
    when = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(at);
  } catch {
    when = at.toISOString();
  }
  return `[Сейчас у компании: ${when} (${tz}). Клиент этой строки не писал.]`;
}

export type AgentAction = { type: string; value: string };
const ACTION_RE = /\[\[ACTION\s+([a-z_]{1,30})\s*:\s*([^\]\n]{1,200})\]\]/gi;

/**
 * Убирает служебные метки из ответа: передачу менеджеру [[HANDOFF]] и действия для своего бота
 * [[ACTION check: Нурофен 200]] (бот показывает по ним кнопки). Клиент меток не видит.
 */
export function extractHandoff(text: string): { text: string; handoff: boolean; actions: AgentAction[] } {
  const handoff = text.includes(HANDOFF_MARKER);
  const actions: AgentAction[] = [];
  const clean = text.replaceAll(HANDOFF_MARKER, "").replace(ACTION_RE, (_m, type: string, value: string) => {
    actions.push({ type: type.toLowerCase(), value: value.trim() });
    return "";
  });
  return { text: clean.trim(), handoff, actions };
}
