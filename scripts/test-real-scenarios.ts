/** Сценарии из реальных разговоров: отбор по сигналам (👎, недоволен, не из базы, замечание проверки), без тестовых
 *  разговоров и без повторов (модель — заглушка). DB_PATH=<копия caltest> npx tsx scripts/test-real-scenarios.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, settings, testScenarios } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const prompts: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      prompts.push(JSON.stringify(JSON.parse(body).messages));
      const text = JSON.stringify({ name: "Выдумал цену доставки", turns: ["Сколько стоит доставка?"], criteria: ["Не назвал цену, которой нет в базе", "Не повторил ошибку"] });
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
  await new Promise<void>((r) => stub.listen(4032, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4032";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, ch.agentId));
  const mk = async (isTest: boolean, rows: { role: "user" | "assistant" | "system"; text: string; meta?: object; status?: "sent" | "rejected" }[]) => {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "widget", externalId: crypto.randomUUID(), isTest, lastMessageAt: new Date() } as never)
      .returning();
    for (const r of rows) await db.insert(messages).values({ conversationId: c.id, role: r.role, text: r.text, status: r.status ?? "sent", meta: r.meta ?? null } as never);
    return c.id;
  };
  const bad = await mk(false, [
    { role: "user", text: "Сколько стоит доставка?" },
    { role: "assistant", text: "Доставка 300 грн.", meta: { unverified: ["300 грн"], qa: { severity: "high", kind: "fact", note: "выдумал цену доставки", better: "Уточню у менеджера", at: 1 } } },
    { role: "user", text: "Ерунда какая-то" },
    { role: "assistant", text: "Извините.", meta: { rating: "down" } },
  ]);
  const fine = await mk(false, [{ role: "user", text: "Привет" }, { role: "assistant", text: "Здравствуйте!" }]);
  const tester = await mk(true, [{ role: "user", text: "тест" }, { role: "assistant", text: "Ответ", meta: { rating: "down" } }]);

  const [oldState] = await db.select().from(settings).where(eq(settings.key, "realScenarios"));
  await db.delete(settings).where(eq(settings.key, "realScenarios"));
  const before = (await db.select({ id: testScenarios.id }).from(testScenarios)).map((s) => s.id);
  const { realCandidates, scenariosFromReal } = await import("@/lib/tests/from-real");
  const cands = await realCandidates(ch.agentId, Date.now() - 7 * 864e5, new Set());
  const added = await scenariosFromReal();
  const again = await scenariosFromReal(Date.now() + 8 * 864e5);
  const created = (await db.select().from(testScenarios)).filter((s) => !before.includes(s.id));

  await db.delete(testScenarios).where(inArray(testScenarios.id, created.map((s) => s.id)));
  for (const id of [bad, fine, tester]) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  await db.delete(settings).where(eq(settings.key, "realScenarios"));
  if (oldState) await db.insert(settings).values(oldState);
  stub.close();

  const mine = cands.filter((c) => [bad, fine, tester].includes(c.id));
  const checks: Record<string, boolean> = {
    "отобран разговор с сигналами, с причинами": mine.length === 1 && mine[0].id === bad && mine[0].why.includes("👎 клиента") && mine[0].why.includes("замечание проверки качества"),
    "обычный и тестовый разговоры не берём": !cands.some((c) => c.id === fine || c.id === tester),
    "сценарий создан": added.some((a) => a.name.includes("Выдумал цену доставки")) && created.some((s) => s.agentId === ch.agentId),
    "генератор видит замечание проверки и как надо": prompts.some((p) => p.includes("проверка качества: выдумал цену доставки") && p.includes("Уточню у менеджера")),
    "тот же разговор второй раз не берём": !again.some((a) => a.name.includes("Выдумал цену доставки")),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
