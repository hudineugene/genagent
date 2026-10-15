import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { MAX_TOOL_ROUNDS, runTool, type ChatRequest, type ChatStreamEvent, type ChatUsage } from "./types";

// Модели, для которых включаем серверный fallback при отказе (stop_reason "refusal").
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5"]);

const clients = new Map<string, Anthropic>();
function getClient(apiKey: string) {
  let c = clients.get(apiKey);
  if (!c) clients.set(apiKey, (c = new Anthropic({ apiKey })));
  return c;
}

export async function* streamAnthropic(
  apiKey: string,
  model: string,
  req: ChatRequest,
): AsyncGenerator<ChatStreamEvent> {
  const client = getClient(apiKey);
  const withFallback = FALLBACK_MODELS.has(model);
  const tools: Anthropic.Beta.BetaTool[] | undefined = req.tools?.length
    ? req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        // Вход инструмента приходит потоком сразу; проверяем его сами (runTool → zod).
        eager_input_streaming: true,
      }))
    : undefined;

  const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
  const usage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let servedBy = `anthropic:${model}`;
  let stopReason: string | null = null;
  let jsonRetries = 0;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: req.maxTokens ?? 16000,
        // Системный промпт стабилен для агента — кэшируем его, история диалога кэшируется автоматически.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        cache_control: { type: "ephemeral" },
        messages,
        ...(tools ? { tools } : {}),
        output_config: { effort: req.effort ?? "low" },
        ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }

    let final: Anthropic.Beta.BetaMessage;
    try {
      final = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Вход инструмента не разобрался как JSON — повторяем этот шаг (не больше 2 раз подряд).
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      round--;
      continue;
    }

    servedBy = `anthropic:${final.model}`;
    stopReason = final.stop_reason;
    usage.inputTokens +=
      final.usage.input_tokens + (final.usage.cache_creation_input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0);
    usage.outputTokens += final.usage.output_tokens;
    usage.cacheReadTokens! += final.usage.cache_read_input_tokens ?? 0;

    const calls = final.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    // Отказ может оборвать вызов инструмента на середине — такие вызовы не выполняем.
    if (!req.tools?.length || !calls.length || final.stop_reason !== "tool_use") break;
    if (round === MAX_TOOL_ROUNDS) break;

    // Ответ модели возвращаем целиком (с блоками размышлений) — так требует API для продолжения.
    messages.push({ role: "assistant", content: final.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const r = await runTool(req.tools, call.name, call.input);
      yield { type: "tool", name: call.name, input: call.input, result: r.result, error: r.error };
      results.push({ type: "tool_result", tool_use_id: call.id, content: r.result, ...(r.error ? { is_error: true } : {}) });
    }
    // Все результаты — одним сообщением пользователя.
    messages.push({ role: "user", content: results });
  }

  yield { type: "done", servedBy, stopReason, usage };
}

/** Однократный вызов со структурированным JSON-ответом (генерация агента, сценарии тестов, ИИ-судья). */
export async function generateJson<T>(
  apiKey: string,
  model: string,
  opts: { system: string; prompt: string; schema: Record<string, unknown>; effort?: "low" | "medium" | "high" },
): Promise<{ data: T; usage: ChatUsage; model: string }> {
  const client = getClient(apiKey);
  const withFallback = FALLBACK_MODELS.has(model);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 32000,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: opts.schema } },
    ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Модель отказалась выполнять запрос");
  if (msg.stop_reason === "max_tokens") throw new Error("Ответ модели обрезан (max_tokens)");
  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Пустой ответ модели");
  return {
    data: JSON.parse(text.text) as T,
    model: `anthropic:${msg.model}`,
    usage: {
      inputTokens:
        msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0),
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    },
  };
}
