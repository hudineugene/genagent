/**
 * Проверка «ответ сотрудника → предложение для базы знаний» на копии базы, без ИИ (заглушка Anthropic):
 * DB_PATH=<копия caltest> npx tsx scripts/test-gap-operator.ts
 */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { agents, channels, conversations, knowledgeGaps, messages } from "@/db/schema";
import { setSetting, getSetting } from "@/lib/settings";

const ANSWER = {
  gaps: [
    {
      question: "Есть ли рассрочка от застройщика?",
      missing: "условия рассрочки",
      exchanges: [0],
      matchId: "",
      suggestedAnswer: "Рассрочка до 24 месяцев без процентов при первом взносе 30%.",
    },
  ],
};

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);

  let prompt = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      prompt = JSON.parse(body).messages[0].content;
      const text = JSON.stringify(ANSWER);
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => server.listen(4011, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4011";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { analyzeGaps } = await import("@/lib/agent/gaps");

  const [channel] = await db.select().from(channels).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  const now = Date.now();
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: agent.clientId, agentId: agent.id, channelId: channel.id, channelType: channel.type, externalId: "gap-test-" + now, contactName: "Тест" } as never)
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "А рассрочка у вас есть?", createdAt: new Date(now - 3000) },
    { conversationId: conv.id, role: "assistant", text: "Уточню у менеджера, он скоро ответит.", meta: { handoff: true }, createdAt: new Date(now - 2000) },
    { conversationId: conv.id, role: "operator", text: "Да, рассрочка до 24 месяцев без процентов, первый взнос 30%.", createdAt: new Date(now - 1000) },
  ] as never);
  const cursors = (await getSetting<Record<string, number>>("gapsCursor")) ?? {};
  await setSetting("gapsCursor", { ...cursors, [agent.id]: now - 60_000 });

  const r = await analyzeGaps(agent.id);
  console.log("разбор:", r);
  console.log("в промпте есть ответ сотрудника:", prompt.includes("Сотрудник: Да, рассрочка до 24 месяцев"));
  const [gap] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.question, ANSWER.gaps[0].question));
  console.log("сохранено предложение:", gap?.suggestion);

  await db.delete(knowledgeGaps).where(eq(knowledgeGaps.id, gap.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  server.close();
  process.exit(prompt.includes("Сотрудник:") && gap?.suggestion === ANSWER.gaps[0].suggestedAnswer ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
