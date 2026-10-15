import "server-only";
import { parseModelId, PROVIDER_ENV } from "@/lib/models";
import { streamAnthropic } from "./anthropic";
import { streamOpenAICompatible } from "./openai";
import type { ChatRequest, ChatStreamEvent } from "./types";

export type { AgentTool, ChatRequest, ChatStreamEvent, ChatMessage } from "./types";

export class MissingKeyError extends Error {
  constructor(public envName: string) {
    super(`Не задан ключ ${envName} в .env`);
  }
}

/** Единая точка вызова любой модели: возвращает поток текстовых фрагментов и итог. */
export async function* streamChat(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
  const { provider, model } = parseModelId(req.model);
  const key = process.env[PROVIDER_ENV[provider]];
  if (!key) throw new MissingKeyError(PROVIDER_ENV[provider]);

  if (provider === "anthropic") {
    yield* streamAnthropic(key, model, req);
  } else {
    yield* streamOpenAICompatible(provider, key, model, req);
  }
}
