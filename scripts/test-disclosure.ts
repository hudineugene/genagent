/**
 * Раскрытие ИИ (EU AI Act, ст. 50): первая строка первого ответа агента в разговоре — «Вас приветствует
 * ИИ-ассистент компании …» на языке клиента; во втором ответе её нет; выключено — нет; свой текст с {company}.
 * Модель — заглушка. DB_PATH=<копия caltest> npx tsx scripts/test-disclosure.ts
 */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Добрый день! Чем помочь?" } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => server.listen(4073, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4073";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { respond } = await import("@/lib/conversations");

  const [widget] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, widget.agentId));
  const [client] = await db.select().from(clients).where(eq(clients.id, widget.clientId));
  const original = agent.config as AgentConfig;
  const setCfg = (d: AgentConfig["aiDisclosure"], replyLanguage: AgentConfig["replyLanguage"] = "auto") =>
    db.update(agents).set({ status: "active", config: { ...original, model: "anthropic:claude-haiku-5-5", answerCheck: false, factGuard: "off", aiDisclosure: d, replyLanguage } }).where(eq(agents.id, agent.id));
  const made: string[] = [];
  const ask = async (convId: string, text: string) => {
    await db.insert(messages).values({ conversationId: convId, role: "user", text, createdAt: new Date() } as never);
    await respond(convId);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt));
    return rows.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  };
  const newConv = async (context: object = {}) => {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: widget.clientId, agentId: widget.agentId, channelId: widget.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "Тест", context } as never)
      .returning();
    made.push(c.id);
    return c.id;
  };

  await setCfg({ enabled: true, text: "" });
  const c1 = await newConv();
  const first = await ask(c1, "Здравствуйте");
  const second = await ask(c1, "Сколько стоит?");
  const uk = await ask(await newConv({ language: "uk" }), "Добрий день");
  await setCfg({ enabled: true, text: "Это ИИ «{company}», не человек." });
  const custom = await ask(await newConv(), "Привет");
  await setCfg({ enabled: false, text: "" });
  const off = await ask(await newConv(), "Привет");
  await setCfg(undefined);
  const legacy = await ask(await newConv(), "Привет");

  for (const id of made) await db.delete(conversations).where(eq(conversations.id, id));
  await db.update(agents).set({ status: agent.status, config: original }).where(eq(agents.id, agent.id));
  server.close();

  const checks: Record<string, boolean> = {
    "первый ответ начинается с раскрытия и названия компании": first.startsWith(`🤖 Вас приветствует ИИ-ассистент компании «${client.name}»`) && first.endsWith("Добрый день! Чем помочь?"),
    "во втором ответе раскрытия нет": second === "Добрый день! Чем помочь?",
    "по языку клиента — по-украински": uk.startsWith("🤖 Вас вітає ШІ-асистент компанії"),
    "свой текст с {company}": custom.startsWith(`Это ИИ «${client.name}», не человек.`),
    "выключено и старые агенты без настройки — как раньше": off === "Добрый день! Чем помочь?" && legacy === "Добрый день! Чем помочь?",
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
