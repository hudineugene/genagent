/** Агент учится на ответах менеджера + черновик ответа при передаче (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-learn.ts */
import http from "node:http";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, kbSources, knowledgeGaps, messages, settings, type ApiConfig } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const prompts: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const prompt = String(JSON.parse(body).messages[0].content);
      prompts.push(prompt);
      const data = prompt.includes("Переписка (последнее внизу)")
        ? prompt.split("Известн")[0].includes("доставка")
          ? { useful: true, question: "Сколько стоит доставка стикерпака?", answer: "Доставка не нужна: стикерпак присылаем ссылкой в Telegram, бесплатно.", matchId: null }
          : { useful: false, question: "", answer: "", matchId: null }
        : { wants: "Пак с котом", discussed: "Цены", expects: "Срок", draft: "Вітаю! Пак на 10 стікерів — від 2000 грн, зробимо за 5 днів." };
      const text = JSON.stringify(data);
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
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
  await new Promise<void>((r) => stub.listen(4022, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4022";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId));
  await db.update(agents).set({ status: "active", config: { ...agent.config, kbSourceIds: [] } }).where(eq(agents.id, agent.id));
  const t0 = Date.now() - 30 * 60 * 1000;
  const mk = async (ext: string, msgs: [string, string][]) => {
    const [c] = await db.insert(conversations).values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "api", externalId: ext }).returning();
    let i = 0;
    for (const [role, text] of msgs) await db.insert(messages).values({ conversationId: c.id, role: role as "user", text, status: "sent", createdAt: new Date(t0 + i++ * 1000) });
    return c;
  };
  const useful = await mk(`learn-a-${Date.now()}`, [["user", "А доставка сколько стоит?"], ["operator", "Доставка не нужна — пак присылаем ссылкой в Telegram, это бесплатно."]]);
  const personal = await mk(`learn-b-${Date.now()}`, [["user", "Где мой заказ?"], ["operator", "Ваш заказ уже у дизайнера, сегодня пришлём эскиз."]]);
  await db.delete(settings).where(eq(settings.key, "learnCursor"));
  const { runLearning } = await import("@/lib/agent/learn");
  const ids = await runLearning();
  const [gap] = ids.length ? await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, ids[0])) : [];
  const again = await runLearning();

  const { addAnswerToKb } = await import("@/lib/agent/kb-answers");
  const before = await db.select({ id: kbSources.id }).from(kbSources).where(and(eq(kbSources.clientId, ch.clientId), eq(kbSources.title, "Ответы на частые вопросы")));
  const added = gap ? await addAnswerToKb(gap.id, gap.suggestion ?? "") : { error: "no gap" };
  const [faq] = await db.select().from(kbSources).where(and(eq(kbSources.clientId, ch.clientId), eq(kbSources.title, "Ответы на частые вопросы")));
  const [agentAfter] = await db.select().from(agents).where(eq(agents.id, agent.id));
  const [gapAfter] = gap ? await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, gap.id)) : [];

  // Черновик при передаче + очистка после ответа менеджера
  const { handoffSummary } = await import("@/lib/agent/summary");
  const h = await handoffSummary(useful.id, { agentId: agent.id, clientId: ch.clientId, kbSourceIds: null, language: "uk" });
  await db.update(conversations).set({ context: { managerDraft: { text: h.draft ?? "", at: Date.now() } } }).where(eq(conversations.id, useful.id));
  await db.update(channels).set({ config: { ...(ch.config as ApiConfig), dmAt: Date.now() } }).where(eq(channels.id, ch.id));
  const { operatorReplyCore } = await import("@/lib/operator");
  const sent = await operatorReplyCore(useful.id, h.draft ?? "x");
  const [convAfter] = await db.select().from(conversations).where(eq(conversations.id, useful.id));

  // Вернуть как было
  await db.update(channels).set({ config: ch.config }).where(eq(channels.id, ch.id));
  await db.update(agents).set({ status: agent.status, config: agent.config }).where(eq(agents.id, agent.id));
  if (gap) await db.delete(knowledgeGaps).where(eq(knowledgeGaps.id, gap.id));
  if (!before.length && faq) await db.delete(kbSources).where(eq(kbSources.id, faq.id));
  await db.delete(conversations).where(eq(conversations.id, useful.id));
  await db.delete(conversations).where(eq(conversations.id, personal.id));
  stub.close();

  const checks: Record<string, boolean> = {
    "полезный ответ менеджера → предложение": ids.length === 1 && gap?.question === "Сколько стоит доставка стикерпака?" && Boolean(gap?.suggestion?.includes("бесплатно")),
    "личный ответ — пропущен (модель решила)": prompts.filter((p) => p.includes("Переписка (последнее внизу)")).length === 2,
    "повторно те же ответы не разбираем": again.length === 0,
    "в базе знаний: вопрос и ответ": added.ok === true && Boolean(faq?.content.includes("Вопрос: Сколько стоит доставка")),
    "вопрос закрыт": gapAfter?.status === "resolved",
    "агенту с явным списком источников добавлен новый источник": !before.length ? Boolean((agentAfter.config as { kbSourceIds?: string[] }).kbSourceIds?.includes(faq?.id ?? "-")) : true,
    "черновик ответа при передаче": Boolean(h.draft?.includes("2000 грн")) && Boolean(h.summary?.includes("Пак с котом")),
    "черновику дали базу знаний и язык": prompts.some((p) => p.includes("База знаний компании") || p.includes("Переписка:")),
    "после ответа менеджера черновик убран": !sent.error && !convAfter.context?.managerDraft,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
