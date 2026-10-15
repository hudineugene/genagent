/** «В автотест» из разговора на копии базы (модель — заглушка): DB_PATH=<копия caltest> npx tsx scripts/test-scenario-from-conv.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { channels, conversations, messages, testScenarios } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  let prompt = "";
  const answer = { name: "Выдуманная цена", turns: ["Сколько стоит пак из 10 стикеров?"], criteria: ["Называет цену из базы знаний", "Не повторил ошибку: не назвал цену, которой нет в базе"] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      prompt = JSON.parse(body).messages[0].content;
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: JSON.stringify(answer) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => server.listen(4015, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4015";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { scenarioFromConversation } = await import("@/lib/tests/engine");

  const [ch] = await db.select().from(channels).limit(1);
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: ch.type, externalId: crypto.randomUUID(), contactName: "Тест" } as never)
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Сколько стоит пак из 10 стикеров?", createdAt: new Date(Date.now() - 3000) },
    { conversationId: conv.id, role: "assistant", text: "9 999 грн", meta: { rating: "down", unverified: ["9 999"] }, createdAt: new Date(Date.now() - 2000) },
    { conversationId: conv.id, role: "operator", text: "Извините, 10 анимированных — 2 400 грн.", createdAt: new Date(Date.now() - 1000) },
  ] as never);
  const r = await scenarioFromConversation(conv.id);
  const [sc] = await db.select().from(testScenarios).where(eq(testScenarios.id, r.id));
  const checks: Record<string, boolean> = {
    "в промпте пометки 👎 и «нет в базе знаний»": prompt.includes("👎") && prompt.includes("данных нет в базе знаний: 9 999"),
    "в промпте ответ сотрудника": prompt.includes("Сотрудник: Извините, 10 анимированных"),
    "сценарий создан у агента разговора": sc?.agentId === ch.agentId && sc.mode === "script",
    "реплики и критерии": sc?.turns.length === 1 && sc.criteria.length === 2 && sc.name.startsWith("Из разговора:"),
  };
  console.log(checks);
  await db.delete(testScenarios).where(eq(testScenarios.id, r.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  server.close();
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
