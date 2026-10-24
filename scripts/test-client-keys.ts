/** Свои ключи клиента: ответ агента и проверка ответа идут через ключ Anthropic клиента, клиент без ключа — через
 *  ключ студии; картинка — через OpenAI клиента; расход помечается «за счёт клиента»; ключи не смешиваются между
 *  параллельными клиентами. Anthropic и OpenAI — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-client-keys.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, usageLog } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const seen: { path: string; key: string }[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const key = String(req.headers["x-api-key"] ?? req.headers.authorization ?? "").replace(/^Bearer /, "");
      seen.push({ path: req.url ?? "", key });
      if (req.url?.includes("/images/generations")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }));
      }
      // Ответ медленный — чтобы два клиента шли одновременно и ключи могли бы «перепутаться»
      await new Promise((r) => setTimeout(r, 150));
      const b = JSON.parse(body || "{}");
      const text = b.output_config?.format ? JSON.stringify({ ok: true, problems: [] }) : "Здравствуйте! Для семьи с детьми подойдут апартаменты Riviera Relleu от 95 000 € и виллы Sierra Verde от 550 000 € с бассейном. Расскажу подробнее о каждом варианте и помогу выбрать подходящий.";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4064, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4064";
  process.env.ANTHROPIC_API_KEY = "sk-ant-studio";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4064/v1";
  process.env.OPENAI_API_KEY = "sk-openai-studio";

  const [base] = await db.select().from(agents).limit(1);
  const cfg = agentConfigSchema.parse(base.config);
  const made: { client: string; agent: string; channel: string; conv: string }[] = [];
  const setup = async (name: string, keys: Record<string, string>) => {
    const [c] = await db.insert(clients).values({ name, apiKeys: keys }).returning();
    const { id: _id, ...rest } = base;
    void _id;
    const [a] = await db
      .insert(agents)
      .values({ ...rest, clientId: c.id, name: `keys-${name}`, status: "active", config: { ...cfg, model: "anthropic:claude-haiku-5-5", answerCheck: true, kbSourceIds: [], calendar: { ...cfg.calendar, enabled: false } } })
      .returning();
    const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
    const [conv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: `keys-${name}`, contactName: "Тест" }).returning();
    await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Какие у вас есть варианты квартир у моря и что посоветуете для семьи с детьми?" });
    made.push({ client: c.id, agent: a.id, channel: ch.id, conv: conv.id });
    return { c, conv };
  };
  const own = await setup("own", { anthropic: "sk-ant-client", openai: "sk-openai-client" });
  const plain = await setup("plain", {});

  const { respond } = await import("@/lib/conversations");
  const { withKeys } = await import("@/lib/keys");
  const { generateContentImage, removeContentImage } = await import("@/lib/content/images");
  // Оба клиента — одновременно
  await Promise.all([respond(own.conv.id), respond(plain.conv.id)]);
  const ownCalls = seen.filter((s) => s.key === "sk-ant-client").length;
  const studioCalls = seen.filter((s) => s.key === "sk-ant-studio").length;
  const replies = await db.select({ c: messages.conversationId, role: messages.role }).from(messages).where(inArray(messages.conversationId, [own.conv.id, plain.conv.id]));
  const usage = await db.select({ clientId: usageLog.clientId, ownKey: usageLog.ownKey }).from(usageLog).where(inArray(usageLog.clientId, [own.c.id, plain.c.id]));

  seen.length = 0;
  const imgOwn = await withKeys({ clientId: own.c.id }, () => generateContentImage("test"));
  const imgStudio = await generateContentImage("test");
  const imageKeys = seen.map((s) => s.key);
  removeContentImage(imgOwn);
  removeContentImage(imgStudio);

  for (const m of made) {
    await db.delete(usageLog).where(eq(usageLog.clientId, m.client));
    await db.delete(conversations).where(eq(conversations.id, m.conv));
    await db.delete(channels).where(eq(channels.id, m.channel));
    await db.delete(agents).where(eq(agents.id, m.agent));
    await db.delete(clients).where(eq(clients.id, m.client));
  }
  stub.close();

  const result: Record<string, boolean> = {
    "клиент со своим ключом: ответ и проверка — через его ключ": ownCalls >= 2,
    "клиент без ключа: через ключ студии": studioCalls >= 2,
    "оба клиента получили ответ": replies.filter((r) => r.c === own.conv.id && r.role === "assistant").length === 1 && replies.filter((r) => r.c === plain.conv.id && r.role === "assistant").length === 1,
    "расход клиента со своим ключом помечен «за его счёт»": usage.filter((u) => u.clientId === own.c.id).length >= 2 && usage.filter((u) => u.clientId === own.c.id).every((u) => u.ownKey),
    "расход клиента без ключа — студии": usage.filter((u) => u.clientId === plain.c.id).length >= 2 && usage.filter((u) => u.clientId === plain.c.id).every((u) => !u.ownKey),
    "картинка: в области клиента — его OpenAI, вне — студии": imageKeys.join(",") === "sk-openai-client,sk-openai-studio",
  };
  console.log(result, { ownCalls, studioCalls });
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
