import { z } from "zod";
import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { agentConfigSchema } from "@/lib/agent/types";
import { prepareChat } from "@/lib/agent/runtime";
import { findModel } from "@/lib/models";
import { logUsage } from "@/lib/usage";
import { MissingKeyError, streamChat } from "@/lib/llm";

const bodySchema = z.object({
  clientId: z.string().uuid(),
  config: agentConfigSchema,
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
    .min(1)
    .max(100),
});

/**
 * Тест-чат конструктора. Отвечает потоком NDJSON:
 * {"t":"text","v":"..."} — фрагменты ответа, {"t":"tool",...} — вызов инструмента, {"t":"done",...} — итог, {"t":"error",...} — ошибка.
 */
export async function POST(req: Request) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
  const { clientId, config, messages } = parsed.data;

  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return new Response("Client not found", { status: 404 });

  const { system, messages: history, kb: kbInfo, tools, webSearch } = await prepareChat(config, client, messages, { mode: "dry" });
  if (!history.length) return Response.json({ error: "no_user_message" }, { status: 400 });
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const started = Date.now();
      try {
        for await (const ev of streamChat({
          model: config.model,
          effort: config.effort,
          system,
          messages: history,
          signal: req.signal,
          tools,
          webSearch,
        })) {
          if (ev.type === "text") send({ t: "text", v: ev.text });
          else if (ev.type === "tool") send({ t: "tool", name: ev.name, input: ev.input, result: ev.result, error: ev.error });
          else {
            const ms = Date.now() - started;
            const cost = await logUsage({
              source: "playground",
              model: findModel(ev.servedBy) ? ev.servedBy : config.model,
              usage: ev.usage,
              clientId,
              ms,
            }).catch(() => null);
            send({ t: "done", ...ev, ms, kb: kbInfo, cost });
          }
        }
      } catch (e) {
        if (!req.signal.aborted) send({ t: "error", ...describeError(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function describeError(e: unknown): { code: string; message: string } {
  if (e instanceof MissingKeyError) return { code: "missing_key", message: e.envName };
  if (e instanceof Anthropic.APIError) return { code: `anthropic_${e.status ?? "error"}`, message: e.message };
  if (e instanceof OpenAI.APIError) return { code: `openai_${e.status ?? "error"}`, message: e.message };
  console.error("playground error", e);
  return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
}
