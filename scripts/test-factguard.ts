/**
 * Проверка цифр в ответах агента на копии базы (модель — заглушка, называет выдуманную цену):
 * DB_PATH=<копия caltest> npx tsx scripts/test-factguard.ts
 */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { agents, channels, conversations, messages } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const REPLY = "Пакет коштує 9 999 грн, пишіть на fake-shop.com";
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: REPLY } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => server.listen(4014, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4014";
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { respond } = await import("@/lib/conversations");

  const [widget] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, widget.agentId));
  const original = agent.config as AgentConfig;
  const [api] = await db
    .insert(channels)
    .values({ clientId: widget.clientId, agentId: widget.agentId, type: "api", name: "fact-test", config: { key: "ga_fact-test", label: "fact-test" } } as never)
    .returning();
  const run = async (guard: "flag" | "block", channel: typeof widget) => {
    await db.update(agents).set({ status: "active", config: { ...original, model: "anthropic:claude-haiku-5-5", factGuard: guard } }).where(eq(agents.id, agent.id));
    const [c] = await db
      .insert(conversations)
      .values({ clientId: channel.clientId, agentId: channel.agentId, channelId: channel.id, channelType: channel.type, externalId: crypto.randomUUID(), contactName: "Тест" } as never)
      .returning();
    await db.insert(messages).values({ conversationId: c.id, role: "user", text: "Скільки коштує пакет?", createdAt: new Date() } as never);
    await respond(c.id);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(asc(messages.createdAt));
    await db.delete(conversations).where(eq(conversations.id, c.id));
    return rows.filter((m) => m.role !== "user").map((m) => ({ role: m.role, status: m.status, text: m.text.slice(0, 30), unverified: m.meta?.unverified }));
  };

  const flag = await run("flag", widget);
  const blockApi = await run("block", api);
  const blockWidget = await run("block", widget);
  console.log({ flag, blockApi, blockWidget });
  const checks: Record<string, boolean> = {
    "помечать: ответ отправлен, отмечены цена и сайт": flag.some((m) => m.role === "assistant" && m.status === "sent" && m.unverified?.includes("9 999") && m.unverified?.includes("fake-shop.com")),
    "не отправлять, свой бот: ответ отклонён, служебная запись": blockApi.some((m) => m.role === "assistant" && m.status === "rejected") && blockApi.some((m) => m.text === "fact_blocked"),
    "не отправлять, сайт: ответ ждёт одобрения": blockWidget.some((m) => m.role === "assistant" && m.status === "draft"),
  };
  console.log(checks);

  await db.update(agents).set({ status: agent.status, config: original }).where(eq(agents.id, agent.id));
  await db.delete(channels).where(eq(channels.id, api.id));
  server.close();
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
