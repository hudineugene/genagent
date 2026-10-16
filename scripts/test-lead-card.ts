/** Карточка лида: заполнение со слов клиента, обновление после паузы, горячий клиент в сводке лидов, текст для Telegram
 *  (модель — заглушка). DB_PATH=<копия caltest> npx tsx scripts/test-lead-card.ts */
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
      const b = JSON.parse(body);
      prompts.push(JSON.stringify(b.system) + JSON.stringify(b.messages));
      const text = JSON.stringify({
        temperature: "hot",
        reason: "просит показать виллу в субботу и оставил телефон",
        fields: [
          { label: "Что ищет", value: "вилла с бассейном" },
          { label: "Бюджет", value: "до 600 000 €" },
          { label: "Контакт", value: "оставил телефон" },
          { label: "Сроки", value: "" },
        ],
      });
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
  await new Promise<void>((r) => stub.listen(4033, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4033";
  process.env.ANTHROPIC_API_KEY = "stub";
  // Оповещения о горячих клиентах — в никуда: тест не должен писать в настоящий Telegram
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:9";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId));
  await db.update(agents).set({ status: "active", config: { ...agent.config, leadFields: "Что ищет, Бюджет, Сроки, Контакт" } }).where(eq(agents.id, agent.id));
  const mk = async (minutesAgo: number) => {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const [c] = await db
      .insert(conversations)
      .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "Lucía", lastMessageAt: at } as never)
      .returning();
    await db.insert(messages).values([
      { conversationId: c.id, role: "user", text: "Хочу виллу с бассейном до 600 000 €, покажете в субботу? Мой телефон +34 600 111 222", status: "sent", createdAt: at },
      { conversationId: c.id, role: "assistant", text: "Да, Sierra Verde подходит. Запишу на субботу.", status: "sent", createdAt: at },
    ] as never);
    return c.id;
  };
  const quiet = await mk(10);
  const fresh = await mk(1);

  const started = Date.now();
  const { runLeads } = await import("@/lib/agent/lead");
  const n1 = await runLeads();
  const [q] = await db.select().from(conversations).where(eq(conversations.id, quiet));
  const [f] = await db.select().from(conversations).where(eq(conversations.id, fresh));
  await runLeads(); // ничего нового в этом разговоре — его карточку не пересчитываем
  const [q2] = await db.select().from(conversations).where(eq(conversations.id, quiet));
  const { collectLeads, leadsHtml } = await import("@/lib/agent/leads");
  const leads = await collectLeads(Date.now() - 864e5);
  const mine = leads.find((l) => l.conversationId === quiet);
  const html = leadsHtml(leads);
  const { leadHtml } = await import("@/lib/notify/telegram");
  const card = q.context?.lead ? leadHtml(q.context.lead) : "";

  for (const id of [quiet, fresh]) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  await db.update(agents).set({ config: agent.config, status: agent.status }).where(eq(agents.id, agent.id));
  // runLeads проходит по всей копии базы — убрать карточки, которые заполнил этот прогон
  for (const r of await db.select({ id: conversations.id, context: conversations.context }).from(conversations)) {
    if ((r.context?.lead?.at ?? 0) >= started) {
      const { lead: _drop, hotAlertAt: _at, hotAlertPending: _p, ...rest } = r.context ?? {};
      void _drop;
      void _at;
      void _p;
      await db.update(conversations).set({ context: rest }).where(eq(conversations.id, r.id));
    }
  }
  stub.close();

  const checks: Record<string, boolean> = {
    "после паузы — карточка заполнена": n1 >= 1 && q.context?.lead?.temperature === "hot" && q.context.lead.fields.some((x) => x.label === "Бюджет"),
    "пустые поля не сохраняются": !q.context?.lead?.fields.some((x) => x.label === "Сроки"),
    "поля агента и «только со слов клиента» — в запросе": prompts.some((p) => p.includes("Что ищет, Бюджет, Сроки, Контакт") && p.includes("только то, что клиент сам сказал")),
    "клиент пишет прямо сейчас — ждём паузу": !f.context?.lead,
    "без новых сообщений — не оцениваем повторно": q2.context?.lead?.at === q.context?.lead?.at,
    "горячий без передачи — в сводке лидов с полями": mine?.status === "hot" && mine.temperature === "hot" && mine.wants.includes("Бюджет: до 600 000 €"),
    "в сводке — значок и пометка": html.includes("🔥 <b>Lucía</b>") && html.includes("менеджеру ещё не передан"),
    "карточка для Telegram": card.includes("🔥 Горячий") && card.includes("Бюджет: <b>до 600 000 €</b>"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
