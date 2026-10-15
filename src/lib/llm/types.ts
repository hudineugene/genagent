import type { z } from "zod";

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** Инструмент агента (вызов функции): описание для модели + проверка входа + выполнение на нашей стороне. */
export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema входа (для модели) */
  inputSchema: Record<string, unknown>;
  /** Та же схема в zod — вход от модели всегда проверяем перед выполнением */
  parse: z.ZodType<unknown>;
  run: (input: unknown) => Promise<string>;
};

export type ChatRequest = {
  /** "провайдер:модель" */
  model: string;
  system: string;
  messages: ChatMessage[];
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: AgentTool[];
};

export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown; result: string; error?: boolean }
  | { type: "done"; usage: ChatUsage; servedBy: string; stopReason: string | null };

/** Сколько раз подряд модель может вызывать инструменты в одном ответе. */
export const MAX_TOOL_ROUNDS = 5;

/** Выполнить вызов инструмента: проверить вход, запустить, ошибки вернуть модели текстом. */
export async function runTool(tools: AgentTool[], name: string, input: unknown) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { result: `Unknown tool: ${name}`, error: true };
  const parsed = tool.parse.safeParse(input);
  if (!parsed.success) return { result: `Invalid input: ${parsed.error.message.slice(0, 500)}`, error: true };
  try {
    return { result: await tool.run(parsed.data), error: false };
  } catch (e) {
    return { result: `Error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}
