/** Контроль качества: ответ сотрудника оценивается после отправки (если включено у агента), «Проверить ответ» до
 *  отправки даёт замечания и улучшенный вариант, разбор недели считает настроение, жалобы и оценки сотрудников.
 *  Модель — заглушка. DB_PATH=<копия caltest> npx tsx scripts/test-operator-review.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  let reviews = 0;
  let weeklyPrompt = "";
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      const sys = JSON.stringify(b.system ?? "");
      let out: object = {};
      if (sys.includes("Ты проверяешь ответ сотрудника")) {
        reviews++;
        out = { score: 4, problems: ["Резкий тон", "Не назван следующий шаг"], better: "Спасибо, что написали! Уточню наличие и вернусь сегодня до 18:00." };
      } else if (sys.includes("Ты аналитик компании")) {
        weeklyPrompt = JSON.stringify(b.messages);
        out = { summary: "Неделя спокойная.", topics: [], unmet: [], ideas: [], mood: 6, complaints: [{ complaint: "Долго отвечают", count: 2 }], proposals: [] };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: JSON.stringify(out) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4052, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4052";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [agent] = await db.select().from(agents).limit(1);
  const cfg = agent.config;
  const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id)).limit(1);
  const { addMessage } = await import("@/lib/conversations");
  const convIds: string[] = [];
  const mk = async (ext: string) => {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: ch.type, externalId: ext, contactName: "Иван", mode: "human" })
      .returning();
    convIds.push(c.id);
    return c;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 1) Выключено у агента — оценки нет
  await db.update(agents).set({ config: { ...cfg, operatorReview: false } }).where(eq(agents.id, agent.id));
  const c0 = await mk("opr-0");
  await addMessage(c0.id, "user", "Есть ли в наличии?");
  const m0 = await addMessage(c0.id, "operator", "нет");
  await wait(1500);
  const r0 = (await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, m0.id)))[0].meta?.operatorReview;

  // 2) Включено — оценка после отправки
  await db.update(agents).set({ config: { ...cfg, operatorReview: true } }).where(eq(agents.id, agent.id));
  const c1 = await mk("opr-1");
  await addMessage(c1.id, "user", "Когда будет поставка?");
  const m1 = await addMessage(c1.id, "operator", "не знаю");
  await wait(2000);
  const r1 = (await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, m1.id)))[0].meta?.operatorReview;

  // 3) «Проверить ответ» до отправки
  const { reviewReply } = await import("@/lib/agent/operator-review");
  const draft = await reviewReply(c1.id, "не знаю, пишите позже");

  // 4) Разбор недели: настроение, жалобы, оценки сотрудников
  const c2 = await mk("opr-2");
  await addMessage(c2.id, "user", "Спасибо, всё понятно");
  await addMessage(c2.id, "assistant", "Рады помочь!", { meta: { rating: "up" } });
  const { reviewAgent } = await import("@/lib/agent/review");
  const since = Date.now() - 60_000;
  // в разборе — только разговоры этого теста (они самые свежие)
  const week = await reviewAgent(agent.id, since);

  await db.update(agents).set({ config: cfg }).where(eq(agents.id, agent.id));
  await db.delete(messages).where(inArray(messages.conversationId, convIds));
  await db.delete(conversations).where(inArray(conversations.id, convIds));
  stub.close();

  const result: Record<string, boolean> = {
    "выключено — ответ сотрудника не оценивается": !r0,
    "включено — оценка после отправки": r1?.score === 4 && r1.problems.includes("Резкий тон") && r1.better.includes("Уточню"),
    "«Проверить ответ» — замечания и улучшенный вариант": draft?.score === 4 && Boolean(draft?.better),
    "разбор недели: настроение и жалобы": week?.mood?.score === 6 && week.mood.complaints[0]?.complaint === "Долго отвечают",
    "разбор недели: оценки сотрудников и 👍": week?.stats?.operatorAvg === 4 && week.stats.operatorLow === 1 && week.stats.ratingsUp === 1,
    "в разбор ушла оценка ответа сотрудника": weeklyPrompt.includes("оценка 4/10"),
  };
  console.log(result, { reviews });
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
