import "server-only";
import { apiKey } from "@/lib/keys";
import { compileSystemPrompt, type ClientContext } from "./compile";
import type { AgentConfig } from "./types";
import { loadKnowledge } from "@/lib/kb/store";
import type { AgentTool, ChatMessage } from "@/lib/llm";
import { utcToZoned } from "@/lib/google/calendar";
import { calendarTools, type ToolContext } from "./tools";
import { loadAgentTools } from "./custom-tools";
import { formTool, formsNote, loadForms } from "./forms";
import { docTool, docsNote, loadDocTemplates } from "@/lib/documents/templates";
import { loadTables, tableTool, tablesNote } from "@/lib/data/tables";
import { approvalTool, teamNote } from "@/lib/team/approvals";
import { getProgram, loyaltyNote, loyaltyTools } from "@/lib/loyalty/engine";
import { deliveryTool } from "@/lib/logistics/routes";
import { webSearchFor } from "@/lib/services";
import { examplesNote, getExamples } from "./examples";

export const HANDOFF_MARKER = "[[HANDOFF]]";

export type KbInfo = { mode: "full" | "search"; sources: { title: string; url: string | null }[] } | null;

/**
 * Готовит запрос к модели: системный промпт с базой знаний и история диалога.
 * История должна начинаться с сообщения клиента; найденные фрагменты базы знаний
 * в режиме поиска прикладываются к последнему сообщению клиента.
 */
/** Версия того, как ответ собирается вне инструкции (пометки к сообщению клиента и т.п.). Меняется — автотесты
 *  агентов прогоняются заново (lib/tests/auto.ts). Повышайте при правках логики подготовки запроса к модели. */
export const RUNTIME_REV = "2026-10-24.1";

const REPEAT_NOTE =
  "[Клиент повторил своё прошлое сообщение слово в слово (или нажал ту же кнопку). Не повторяй и не пересказывай прежний ответ и не комментируй сам повтор («вы снова нажали…»). Одной-двумя фразами спроси, что осталось непонятным, и предложи конкретный следующий шаг.]";

const AFTER_BREAK_NOTE =
  "[Клиент вернулся к этому вопросу (или снова нажал эту кнопку) спустя время. Это новый запрос: ответь полностью, как в первый раз, и не упоминай, что он уже спрашивал или нажимал это раньше.]";

/** Последнее сообщение клиента совпадает с его предыдущим (без учёта регистра, эмодзи и знаков). */
export function isRepeat(messages: { role: string; content: unknown }[]) {
  const norm = (c: unknown) => (typeof c === "string" ? c.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "");
  const users = messages.filter((m) => m.role === "user");
  if (users.length < 2) return false;
  const a = norm(users.at(-1)?.content);
  return a.length > 0 && a === norm(users.at(-2)?.content);
}

export async function prepareChat(
  config: AgentConfig,
  client: ClientContext & { id: string },
  history: ChatMessage[],
  /** Режим инструментов: live — настоящий канал, dry — тест-чат и автотесты (без записи в календарь). */
  tools: Omit<ToolContext, "clientId"> = { mode: "dry" },
  /** Особенности канала (например, формат письма) — в конец системного промпта. */
  channelNote?: string,
  /** recentRepeat: false — одинаковые сообщения клиента разделены долгим перерывом (это новый запрос, а не повтор) */
  opts: { recentRepeat?: boolean } = {},
): Promise<{ system: string; messages: ChatMessage[]; kb: KbInfo; tools?: AgentTool[]; webSearch?: { maxUses: number } }> {
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
  const forms = await loadForms(client.id, config.formIds ?? []).catch(() => []);
  const templates = await loadDocTemplates(client.id, config.docTemplateIds ?? []).catch(() => []);
  const tables = await loadTables(client.id, config.tableIds ?? []).catch(() => []);
  const loyalty = config.loyaltyProgramId ? await getProgram(config.loyaltyProgramId).then((p) => (p?.enabled && p.clientId === client.id ? p : null)).catch(() => null) : null;
  const fullSystem = [system, examples, formsNote(forms), docsNote(templates), tablesNote(tables), teamNote(config.team), loyaltyNote(loyalty), channelNote].filter(Boolean).join("\n\n");
  const own = await loadAgentTools(client.id, config.toolIds ?? [], tools).catch((e) => {
    console.error("load agent tools failed", e);
    return [];
  });
  const all = [
    ...(config.calendar.enabled ? calendarTools(config.calendar, { ...tools, clientId: client.id }) : []),
    ...own,
    ...forms.map((f) => formTool(f, { ...tools, clientId: client.id })),
    ...templates.map((t) => docTool(t, { ...tools, clientId: client.id })),
    ...tables.map((t) => tableTool(t)),
    ...(config.logistics && apiKey("googleMaps") ? [deliveryTool(client.id)] : []),
    ...(loyalty ? loyaltyTools(loyalty, { ...tools, clientId: client.id }) : []),
    ...(config.team?.enabled && config.team.approvals ? [approvalTool(config.team, { ...tools, clientId: client.id })] : []),
  ];
  const agentTools = all.length ? all : undefined;

  const last = messages[messages.length - 1];
  // Клиент прислал то же, что и прошлым сообщением (часто — та же кнопка): прямая пометка, иначе модель повторяет ответ
  const same = last?.role === "user" && isRepeat(messages);
  // Тот же вопрос сразу — коротко уточнить; спустя время — ответить заново (иначе модель подражает своему
  // прежнему «вы снова нажали…» из истории)
  if (same) last.content = `${opts.recentRepeat !== false ? REPEAT_NOTE : AFTER_BREAK_NOTE}\n\n${last.content}`;
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
  const webSearch = await webSearchFor(config).catch(() => undefined);
  return { system: fullSystem, messages, kb: kbInfo, tools: agentTools, webSearch };
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
