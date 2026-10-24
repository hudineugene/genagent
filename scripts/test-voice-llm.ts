/** Звонки через Vapi / ElevenLabs: «своя модель» в формате OpenAI — без ключа 401; поток chat.completion.chunk и
 *  [DONE], служебные метки не озвучиваются; в инструкциях агента — правила для голоса; звонок — разговор во
 *  «Входящих» (номер, реплики, без дублей); передача менеджеру — пометка и уведомление; ответ целиком без потока.
 *  Модель — заглушка.  DB_PATH=<копия caltest> npx tsx scripts/test-voice-llm.ts */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  let reply = "Добрый день! Запись на завтра в десять утра есть. [[HANDOFF]]";
  const systems: string[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: {} }));
      }
      const b = JSON.parse(body || "{}");
      systems.push(JSON.stringify(b.system ?? ""));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const parts = reply.match(/.{1,12}/g) ?? [];
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          parts.map((p) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: p } })).join("") +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4084, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4084";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4084";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Voice LLM Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const cfg = { ...(agent.config as AgentConfig), model: "anthropic:claude-haiku-5-5", answerCheck: false, factGuard: "off" as const, memory: false };
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "voice-agent", status: "active", config: cfg }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "voice", name: "Vapi", config: { key: "ga_voice_test_key", provider: "vapi" } }).returning();
  const { POST } = await import("@/app/api/agent/[channelId]/chat/completions/route");
  const call = async (key: string, body: object) => POST(new Request("https://x/api/agent/x/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ channelId: ch.id }) });
  const req = {
    model: "gpt-4o",
    stream: true,
    call: { id: "call-77", customer: { number: "+380671112233" } },
    messages: [
      { role: "system", content: "You are a helpful assistant of Vapi" },
      { role: "assistant", content: "Добрый день, чем помочь?" },
      { role: "user", content: "Хочу записаться на завтра" },
    ],
  };
  const denied = await call("wrong", req);
  const res = await call("ga_voice_test_key", req);
  const sse = await res.text();
  const chunks = sse.split("\n\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const spoken = chunks.map((x) => x.choices[0].delta.content ?? "").join("");
  // Повтор того же запроса (платформа шлёт историю целиком) — без дубля реплики клиента
  reply = "Отлично, записал.";
  const plain = await call("ga_voice_test_key", { ...req, stream: false });
  const pj = await plain.json();
  const [conv] = await db.select().from(conversations).where(eq(conversations.channelId, ch.id));
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "без ключа — 401": denied.status === 401,
    "поток в формате OpenAI с [DONE]": res.headers.get("content-type")?.includes("text/event-stream") === true && chunks[0].object === "chat.completion.chunk" && sse.trim().endsWith("data: [DONE]") && chunks.at(-1).choices[0].finish_reason === "stop",
    "служебные метки не озвучиваются": spoken.includes("Запись на завтра") && !spoken.includes("[["),
    "в инструкциях агента — правила для голоса, системное сообщение платформы не используется": systems.some((s) => s.includes("телефонный звонок")) && !systems.some((s) => s.includes("helpful assistant of Vapi")),
    "звонок — разговор с номером, реплика клиента один раз": conv.externalId === "call:call-77" && conv.contactHandle === "+380671112233" && msgs.filter((m) => m.role === "user").length === 1,
    "передача менеджеру — разговор помечен": conv.needsAttention === true,
    "ответ целиком без потока": pj.object === "chat.completion" && pj.choices[0].message.content === "Отлично, записал.",
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
