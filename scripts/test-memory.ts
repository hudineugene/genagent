/** Долгая память о клиенте: факты из затихшего разговора, в контексте агента, «Забыть» (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-memory.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const prompts: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const prompt = JSON.parse(body).messages[0].content as string;
      prompts.push(prompt);
      const facts = prompt.includes("Барсик")
        ? ["Зовут Ліза, просила звертатися на «ти»", "Замовляла стікерпак з рудим котом Барсиком", "Хоче ще анімовані стікери до Нового року", "зовут ліза, просила звертатися на «ти»"]
        : ["Без фактів"];
      const text = JSON.stringify({ facts });
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4020, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4020";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId));
  await db.update(agents).set({ status: "active", config: { ...agent.config, memory: true } }).where(eq(agents.id, agent.id));
  // Разговор затих час назад
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "api", externalId: `memory-test-${Date.now()}`, contactName: "Ліза", lastMessageAt: new Date(hourAgo) })
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Привіт! Я Ліза, давай на ти. Хочу пак з моїм рудим котом Барсиком", status: "sent", createdAt: new Date(hourAgo - 120_000) },
    { conversationId: conv.id, role: "assistant", text: "Чудово! Оформи бриф — і почнемо.", status: "sent", createdAt: new Date(hourAgo - 60_000) },
    { conversationId: conv.id, role: "user", text: "А до Нового року ще анімовані хочу", status: "sent", createdAt: new Date(hourAgo) },
  ]);

  const { runMemory, memoryNote, forgetClient } = await import("@/lib/agent/memory");
  await runMemory();
  const mine = () => db.select().from(conversations).where(eq(conversations.id, conv.id)).then((r) => r[0]);
  const after = await mine();
  const myPrompt = prompts.find((p) => p.includes("Барсик")) ?? "";
  const promptsBefore = prompts.length;
  await runMemory();
  const again = prompts.filter((p) => p.includes("Барсик")).length;
  const note = memoryNote(after.context?.memory) ?? "";

  // Новое сообщение после памяти — в следующий раз модель видит прежние факты и только новое
  await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Барсик передумав, хоче статичні", status: "sent", createdAt: new Date(hourAgo + 1000) });
  await db.update(conversations).set({ lastMessageAt: new Date(hourAgo + 1000) }).where(eq(conversations.id, conv.id));
  await runMemory();
  const second = prompts.filter((p) => p.includes("Барсик")).at(-1) ?? "";

  await forgetClient(conv.id);
  const forgot = await mine();
  await runMemory();
  const relearned = (await mine()).context?.memory?.facts.length ?? 0;

  // Память выключена у агента — не трогаем
  await db.update(conversations).set({ context: {}, lastMessageAt: new Date(hourAgo + 2000) }).where(eq(conversations.id, conv.id));
  await db.update(agents).set({ config: { ...agent.config, memory: false } }).where(eq(agents.id, agent.id));
  const n = prompts.length;
  await runMemory();
  const off = !prompts.slice(n).some((p) => p.includes("Барсик"));
  await db.update(agents).set({ status: agent.status, config: agent.config }).where(eq(agents.id, agent.id));

  const facts = after.context?.memory?.facts ?? [];
  const checks: Record<string, boolean> = {
    "факты сохранены, дубли убраны": facts.length === 3 && facts[1].includes("Барсиком"),
    "учтено до последнего сообщения": after.context?.memory?.upto === hourAgo,
    "модель видела переписку": myPrompt.includes("Прежних фактов нет") && myPrompt.includes("Клиент: А до Нового року"),
    "без новых сообщений — модель не зовём": again === 1 && prompts.length >= promptsBefore,
    "в контексте агента": note.includes("Что ты помнишь о клиенте") && note.includes("- Замовляла стікерпак"),
    "второй раз — прежние факты и только новое": second.includes("Прежние факты:") && second.includes("Барсик передумав") && !second.includes("давай на ти"),
    "«Забыть» стирает и не учит заново": (forgot.context?.memory?.facts.length ?? -1) === 0 && relearned === 0,
    "память выключена — не трогаем": off,
  };
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  stub.close();
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
