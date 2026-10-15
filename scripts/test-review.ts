/**
 * Разбор недели агента на копии базы, без ИИ (заглушка Anthropic):
 * DB_PATH=<копия caltest> npx tsx scripts/test-review.ts
 */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { agents, channels, conversations, messages, settings } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const [channel] = await db.select().from(channels).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, channel.agentId));
  const rules = (agent.config as AgentConfig).rules;
  const firstLine = rules.split("\n").find((l) => l.trim().length > 10) ?? "";

  let prompt = "";
  const answer = {
    summary: "Чаще всего спрашивали про рассрочку и виллы у моря.",
    topics: [{ topic: "Рассрочка", count: 2 }],
    unmet: [{ demand: "Вилла у моря до 300 тыс.", count: 2, detail: "Финестрат, 3 спальни" }],
    ideas: ["Добавить в каталог виллы до 300 тыс."],
    proposals: [
      { title: "Отвечать короче", why: "Клиент поставил 👎 длинному ответу", field: "rules", action: "append", find: "", text: "Отвечай не длиннее трёх предложений.", conversations: [0] },
      { title: "Заменить правило", why: "тест", field: "rules", action: "replace", find: firstLine, text: "НОВОЕ ПРАВИЛО", conversations: [1] },
      { title: "Несуществующий фрагмент", why: "тест", field: "rules", action: "replace", find: "такого текста нет", text: "x", conversations: [] },
    ],
  };
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
  await new Promise<void>((r) => server.listen(4012, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4012";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { reviewAgent, applyProposalToConfig, reviewReportHtml } = await import("@/lib/agent/review");

  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const [conv] = await db
      .insert(conversations)
      .values({ clientId: agent.clientId, agentId: agent.id, channelId: channel.id, channelType: channel.type, externalId: `review-${now}-${i}`, contactName: "Тест" } as never)
      .returning();
    ids.push(conv.id);
    await db.insert(messages).values([
      { conversationId: conv.id, role: "user", text: `Есть вилла у моря до 300 тысяч? (${i})`, createdAt: new Date(now - 3000) },
      { conversationId: conv.id, role: "assistant", text: "Длинный ответ про всё подряд…", meta: i === 0 ? { rating: "down" } : {}, createdAt: new Date(now - 2000) },
      ...(i === 1 ? [{ conversationId: conv.id, role: "system", text: "handoff", meta: { upset: true }, createdAt: new Date(now - 1000) }] : []),
    ] as never);
  }

  const review = await reviewAgent(agent.id, now - 60_000);
  const checks: Record<string, boolean> = {
    "в промпте пометки 👎 и «недоволен»": prompt.includes("👎") && prompt.includes("недоволен"),
    "в промпте текущие правила": rules ? prompt.includes(rules.slice(0, 40)) : true,
    "отчёт сохранён": review?.unmet[0]?.demand === "Вилла у моря до 300 тыс.",
    "правка с несуществующим фрагментом отброшена": review?.proposals.length === (firstLine ? 2 : 1),
    "примеры — id разговоров": review?.proposals[0]?.conversationIds.every((id) => ids.includes(id)) ?? false,
  };
  const appended = review && applyProposalToConfig(agent.config as AgentConfig, review.proposals[0]);
  checks["append добавляет строку"] = Boolean(appended && !("error" in appended) && appended.rules.endsWith("Отвечай не длиннее трёх предложений."));
  if (firstLine && review?.proposals[1]) {
    const replaced = applyProposalToConfig(agent.config as AgentConfig, review.proposals[1]);
    checks["replace заменяет фрагмент"] = !("error" in replaced) && replaced.rules.includes("НОВОЕ ПРАВИЛО") && !replaced.rules.includes(firstLine);
  }
  const html = review ? reviewReportHtml([{ agentId: agent.id, title: "Тест", review }], "https://admin.example") : "";
  checks["отчёт для Telegram"] = html.includes("Вилла у моря") && html.includes("/review");
  console.log(checks);

  await db.delete(conversations).where(inArray(conversations.id, ids));
  await db.delete(settings).where(eq(settings.key, `agentReview:${agent.id}`));
  server.close();
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
