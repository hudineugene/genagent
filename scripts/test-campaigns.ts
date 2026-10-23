/** Рассылки и цепочки: сегмент (тестовые, отписавшиеся и сайт исключены), рассылка с {name} и подсказкой «стоп»,
 *  цепочка по передаче менеджеру (шаг 1 → пауза → клиент ответил → остановлена), «стоп» отписывает, тихие часы,
 *  личное сообщение от ИИ. Telegram и модель — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-campaigns.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, campaignRuns, campaigns, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: { chat: string; text: string }[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.includes("/sendMessage")) {
        const b = JSON.parse(body);
        sent.push({ chat: String(b.chat_id), text: b.text });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
      }
      if (req.url?.startsWith("/bot")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: [] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = JSON.stringify({ send: true, text: "Иван, подобрали для вас виллу с бассейном — показать?" });
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
  await new Promise<void>((r) => stub.listen(4053, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4053";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4053";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [agent] = await db.select().from(agents).limit(1);
  const [tg] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "telegram", name: "camp-tg", config: { token: "123:test" } as never, enabled: false }).returning();
  const [web] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "widget", name: "camp-web", config: {} as never }).returning();
  const lead = { temperature: "hot" as const, reason: "", fields: [{ label: "Ищет", value: "Zebra-вилла" }], at: Date.now(), upto: Date.now() };
  const convIds: string[] = [];
  const mk = async (ch: typeof tg, ext: string, extra: Partial<typeof conversations.$inferInsert> = {}) => {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: ch.type, externalId: ext, contactName: "Иван Петров", context: { lead }, ...extra })
      .returning();
    convIds.push(c.id);
    await db.insert(messages).values({ conversationId: c.id, role: "user", text: "Хочу виллу" });
    await db.insert(messages).values({ conversationId: c.id, role: "assistant", text: "Есть варианты" });
    return c;
  };
  const good = await mk(tg, "9001");
  await mk(tg, "9002", { isTest: true });
  await mk(tg, "9003", { context: { lead, optOut: true } });
  await mk(web, "9004");

  const eng = await import("@/lib/campaigns/engine");
  const seg = { temperature: ["hot" as const], contains: "zebra" };
  const matched = await eng.matchSegment(agent.clientId, seg);

  // Рассылка
  const opts = { quietHours: false, optOutHint: true };
  const [bc] = await db
    .insert(campaigns)
    .values({ clientId: agent.clientId, kind: "broadcast", name: "Акция", segment: seg, steps: [{ delayHours: 0, mode: "text", text: "{name}, у нас новые виллы!" }], options: opts })
    .returning();
  const launched = await eng.launchBroadcast(bc.id);
  await eng.campaignsTick({ enroll: false });
  const bcMsg = sent.at(-1)?.text ?? "";
  const bcSaved = (await db.select().from(messages).where(eq(messages.conversationId, good.id))).find((m) => m.meta?.campaign?.id === bc.id);
  const bcStatus = (await db.select().from(campaigns).where(eq(campaigns.id, bc.id)))[0].status;
  const bcStats = await eng.campaignStats(bc.id);

  // Цепочка по передаче менеджеру: 2 шага (сразу, через час); после ответа клиента — стоп
  const [sq] = await db
    .insert(campaigns)
    .values({
      clientId: agent.clientId,
      kind: "sequence",
      name: "После передачи",
      segment: seg,
      trigger: "handoff",
      enabled: true,
      enabledAt: new Date(Date.now() - 1000),
      status: "active",
      steps: [
        { delayHours: 0, mode: "ai", text: "Напомни о просмотре виллы" },
        { delayHours: 1, mode: "text", text: "Если удобно — запишем на субботу." },
      ],
      options: opts,
    })
    .returning();
  await db.insert(messages).values({ conversationId: good.id, role: "system", text: "handoff" });
  const enrolled = await eng.enrollSequences();
  const before = sent.length;
  await eng.campaignsTick({ enroll: false });
  const aiMsg = sent.length > before ? sent.at(-1)!.text : "";
  const [run1] = await db.select().from(campaignRuns).where(eq(campaignRuns.campaignId, sq.id));
  await new Promise((r) => setTimeout(r, 20));
  await db.insert(messages).values({ conversationId: good.id, role: "user", text: "Спасибо, подумаю" });
  await db.update(campaignRuns).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(campaignRuns.id, run1.id));
  await eng.campaignsTick({ enroll: false });
  const [run2] = await db.select().from(campaignRuns).where(eq(campaignRuns.id, run1.id));

  // «стоп»
  const { addMessage } = await import("@/lib/conversations");
  await addMessage(good.id, "user", "Стоп");
  const afterStop = (await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, good.id)))[0].context;
  const matchedAfterStop = await eng.matchSegment(agent.clientId, seg);

  // Тихие часы: 23:30 по Киеву → 9:00
  const night = eng.quietUntil(new Date("2026-10-23T20:30:00Z"));
  const day = eng.quietUntil(new Date("2026-10-23T10:00:00Z"));

  await db.delete(campaigns).where(inArray(campaigns.id, [bc.id, sq.id]));
  await db.delete(messages).where(inArray(messages.conversationId, convIds));
  await db.delete(conversations).where(inArray(conversations.id, convIds));
  await db.delete(channels).where(inArray(channels.id, [tg.id, web.id]));
  stub.close();

  const result: Record<string, boolean> = {
    "сегмент: только живой клиент в Telegram": matched.length === 1 && matched[0].id === good.id,
    "рассылка: имя подставлено, подсказка «стоп»": launched === 1 && bcMsg.startsWith("Иван, у нас новые виллы!") && bcMsg.includes("«стоп»") && sent.at(-1)?.chat === "9001",
    "рассылка: сообщение в разговоре, итог «готово»": Boolean(bcSaved) && bcStatus === "done" && bcStats.sent === 1,
    "цепочка: набран по передаче, сообщение от ИИ": enrolled === 1 && aiMsg.includes("подобрали для вас виллу"),
    "цепочка: после ответа клиента остановлена": run1.status === "pending" && run1.step === 1 && run2.status === "stopped" && run2.error === "replied",
    "«стоп» отписывает": afterStop?.optOut === true && matchedAfterStop.length === 0,
    "тихие часы: ночью — на 9:00, днём — сразу": night?.toISOString() === "2026-10-24T06:00:00.000Z" && day === null,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
