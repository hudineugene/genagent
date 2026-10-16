/** Сверка вопросов без ответа с базой знаний: знания в запросе, закрывается только то, на что есть ответ (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-gaps-recheck.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, kbSources, knowledgeGaps } from "@/db/schema";
import { indexSource } from "@/lib/kb/store";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  let prompt = "";
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      prompt = JSON.stringify(b.messages);
      // Заглушка «знает» только про парковку
      const ids = [...prompt.matchAll(/([0-9a-f-]{36}): ([^\\]+?)\\n/g)].map((m) => ({ id: m[1], q: m[2] }));
      const results = ids.map(({ id, q }) => (q.includes("парковк") ? { id, answered: true, answer: "Бесплатная парковка во дворе офиса." } : { id, answered: false, answer: "" }));
      const text = JSON.stringify({ results });
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4030, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4030";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [agent] = await db.select().from(agents).where(eq(agents.status, "active")).limit(1);
  const [src] = await db
    .insert(kbSources)
    .values({ clientId: agent.clientId, type: "text", title: "Проверка сверки", status: "ready" })
    .returning();
  indexSource(src.id, agent.clientId, "Проверка сверки", "# Проверка сверки\n\nПарковка: у офиса бесплатная парковка во дворе, 10 мест.");
  const cfg = agent.config;
  if (Array.isArray(cfg.kbSourceIds)) await db.update(agents).set({ config: { ...cfg, kbSourceIds: [...cfg.kbSourceIds, src.id] } }).where(eq(agents.id, agent.id));
  const gaps = await db
    .insert(knowledgeGaps)
    .values([
      { agentId: agent.id, clientId: agent.clientId, question: "Есть ли парковка у офиса?", examples: [] },
      { agentId: agent.id, clientId: agent.clientId, question: "Можно ли прийти с собакой?", examples: [] },
    ])
    .returning();
  const ignoredBefore = await db.select({ id: knowledgeGaps.id, status: knowledgeGaps.status }).from(knowledgeGaps).where(eq(knowledgeGaps.agentId, agent.id));

  const { recheckGaps } = await import("@/lib/agent/gaps-recheck");
  const closed = await recheckGaps(agent.id);
  const after = await db.select().from(knowledgeGaps).where(inArray(knowledgeGaps.id, gaps.map((g) => g.id)));
  const park = after.find((g) => g.question.includes("парковка"));
  const dog = after.find((g) => g.question.includes("собакой"));

  await db.delete(knowledgeGaps).where(inArray(knowledgeGaps.id, gaps.map((g) => g.id)));
  await db.update(agents).set({ config: cfg }).where(eq(agents.id, agent.id));
  await db.delete(kbSources).where(eq(kbSources.id, src.id));
  stub.close();

  const checks: Record<string, boolean> = {
    "в запросе — вопросы и найденные знания": prompt.includes("Есть ли парковка") && prompt.includes("10 мест"),
    "закрыт вопрос, на который знания отвечают": closed >= 1 && park?.status === "resolved" && Boolean(park?.answer?.startsWith("Уже есть в базе знаний")),
    "вопрос без ответа в знаниях остался открытым": dog?.status === "open",
    "другие вопросы агента не тронуты": ignoredBefore.length >= 2,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
