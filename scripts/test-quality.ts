/** Утренняя проверка качества ответов (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-quality.ts */
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
      const prompt = String(JSON.parse(body).messages[0].content);
      prompts.push(prompt);
      // Ищем пару с «Сколько стоит доставка» — к ней замечание
      const m = prompt.match(/\[(\d+)\] Клиент: Сколько стоит доставка/);
      const issues = m ? [{ index: Number(m[1]), severity: "high", kind: "fact", note: "Назвал доставку 300 грн, а в базе — бесплатно", better: "Доставка бесплатная — пак присылаем ссылкой." }] : [];
      const text = JSON.stringify({ issues });
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4023, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4023";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId));
  const now = Date.now();
  const [c] = await db
    .insert(conversations)
    .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "api", externalId: `qa-${now}`, lastMessageAt: new Date(now - 60_000) })
    .returning();
  const add = async (role: "user" | "assistant", text: string, ago: number, meta?: object) => {
    const [m] = await db.insert(messages).values({ conversationId: c.id, role, text, status: "sent", createdAt: new Date(now - ago), meta: meta ?? null }).returning();
    return m;
  };
  await add("user", "Привет! Сколько стоит пак?", 600_000);
  const good = await add("assistant", "Пак на 10 стикеров — от 2000 грн.", 590_000);
  await add("user", "Сколько стоит доставка?", 500_000);
  const bad = await add("assistant", "Доставка — 300 грн.", 490_000, { rating: "down" });

  const { checkAgent, qualityReportHtml, runQualityCheck } = await import("@/lib/agent/quality");
  const from = new Date(now - 24 * 3600_000);
  const r = await checkAgent(agent.id, from, new Date());
  const [badAfter] = await db.select().from(messages).where(eq(messages.id, bad.id));
  const [goodAfter] = await db.select().from(messages).where(eq(messages.id, good.id));
  const callsAfterFirst = prompts.length;
  const again = await checkAgent(agent.id, from, new Date());
  const html = r ? qualityReportHtml([r], "https://admin.example") : "";
  // Проверка выключена у агента — пропускаем
  await db.update(agents).set({ config: { ...agent.config, qualityCheck: false } }).where(eq(agents.id, agent.id));
  const before = prompts.length;
  await runQualityCheck();
  const skipped = !prompts.slice(before).some((p) => p.includes("Доставка — 300"));
  await db.update(agents).set({ config: agent.config }).where(eq(agents.id, agent.id));
  await db.delete(conversations).where(eq(conversations.id, c.id));
  stub.close();

  const myPrompt = prompts.find((p) => p.includes("Доставка — 300")) ?? "";
  const checks: Record<string, boolean> = {
    "замечание записано к нужному ответу": badAfter.meta?.qa?.kind === "fact" && badAfter.meta.qa.severity === "high" && Boolean(badAfter.meta.qa.better?.includes("бесплатная")),
    "хороший ответ — «в порядке»": goodAfter.meta?.qa?.ok === true,
    "модели дали пары и базу знаний": myPrompt.includes("[0] Клиент:") && myPrompt.includes("Консультант: Доставка — 300"),
    "рискованный (👎) — первым": /\[0\] Клиент: Сколько стоит доставка/.test(myPrompt),
    "итог агента": r?.checked === 2 && r.issues.length === 1,
    "повторно не проверяем": (again?.checked ?? -1) === 0 && prompts.length === callsAfterFirst,
    "сводка: замечание и ссылка на диалог": html.includes("замечаний 1 (важных 1)") && html.includes(`/inbox?c=${c.id}`) && html.includes("🔴 факт"),
    "проверка выключена — пропуск": skipped,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
