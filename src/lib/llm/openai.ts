import "server-only";
import OpenAI from "openai";
import { MAX_TOOL_ROUNDS, runTool, type ChatRequest, type ChatStreamEvent } from "./types";

const BASE_URLS: Record<"openai" | "openrouter", string | undefined> = {
  openai: undefined,
  openrouter: "https://openrouter.ai/api/v1",
};

const clients = new Map<string, OpenAI>();
function getClient(provider: "openai" | "openrouter", apiKey: string) {
  const id = `${provider}:${apiKey}`;
  let c = clients.get(id);
  if (!c) clients.set(id, (c = new OpenAI({ apiKey, baseURL: BASE_URLS[provider] })));
  return c;
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export async function* streamOpenAICompatible(
  provider: "openai" | "openrouter",
  apiKey: string,
  model: string,
  req: ChatRequest,
): AsyncGenerator<ChatStreamEvent> {
  const client = getClient(provider, apiKey);
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = req.tools?.length
    ? req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }))
    : undefined;
  const messages: Msg[] = [{ role: "system", content: req.system }, ...req.messages];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let stopReason: string | null = null;
  let servedBy = model;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const stream = await client.chat.completions.create(
      {
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages,
        ...(tools && round < MAX_TOOL_ROUNDS ? { tools } : {}),
      },
      { signal: req.signal },
    );

    let text = "";
    // Вызовы функций приходят по кусочкам — собираем по индексу.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      if (chunk.model) servedBy = chunk.model;
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        yield { type: "text", text: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk.usage) {
        inputTokens += chunk.usage.prompt_tokens;
        outputTokens += chunk.usage.completion_tokens;
        cacheReadTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
    }

    if (!req.tools?.length || !calls.size || stopReason !== "tool_calls") break;

    const list = [...calls.values()];
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: list.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    });
    for (const c of list) {
      let input: unknown;
      let r: { result: string; error: boolean };
      try {
        input = c.args ? JSON.parse(c.args) : {};
        r = await runTool(req.tools, c.name, input);
      } catch {
        input = c.args;
        r = { result: "Invalid JSON in tool arguments", error: true };
      }
      yield { type: "tool", name: c.name, input, result: r.result, error: r.error };
      messages.push({ role: "tool", tool_call_id: c.id, content: r.result });
    }
  }

  yield {
    type: "done",
    servedBy: `${provider}:${servedBy}`,
    stopReason,
    usage: { inputTokens, outputTokens, cacheReadTokens },
  };
}
