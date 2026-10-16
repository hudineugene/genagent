/** Передача менеджеру без дублей и тишина агента, пока клиент отвечает менеджеру (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-handover.ts */
import http from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  // Заглушка модели: следующий ответ — из очереди; запоминаем системный промпт каждого запроса
  const queue: string[] = [];
  const systems: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const sys = typeof parsed.system === "string" ? parsed.system : JSON.stringify(parsed.system ?? "");
      // Выжимка для менеджера (generateJson) — отдельный короткий ответ
      const isSummary = /выжимк|summary/i.test(sys) && !/Передача менеджеру/.test(sys);
      // Карточка лида (обновляется при передаче) — свой ответ, очередь ответов агента не трогает
      const isLead = sys.includes("Заполни карточку");
      if (!isSummary && !isLead) systems.push(sys);
      const text = isLead
        ? JSON.stringify({ temperature: "warm", reason: "ищет дом", fields: [] })
        : isSummary
          ? JSON.stringify({ summary: "Ищет: дом с 5 спальнями", draft: "" })
          : (queue.shift() ?? "Ответ агента");
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
  await new Promise<void>((r) => stub.listen(4026, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4026";
  process.env.ANTHROPIC_API_KEY = "stub";

  const { respond } = await import("@/lib/conversations");
  const [agent] = await db.select().from(agents).limit(1);
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
  const key = "ga_handover-test-key-0123456789";
  const [ch] = await db
    .insert(channels)
    .values({ agentId: agent.id, clientId: agent.clientId, type: "api", name: "handover-test", config: { key, label: "@handover_test_bot" } })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: "api", externalId: "handover-user", contactName: "Анатолий" })
    .returning();
  const all = () => db.select().from(messages).where(eq(messages.conversationId, conv.id));
  const say = async (text: string, at = new Date()) => {
    await db.insert(messages).values({ conversationId: conv.id, role: "user", text, status: "sent", createdAt: at });
    await respond(conv.id);
  };

  // 1) Агент передаёт: причина записана, в действия для бота не попала
  queue.push("Передаю ваш запрос менеджеру.\n[[HANDOFF]]\n[[ACTION reason: нет объекта с 5 спальнями]]");
  await say("Дом на 5 спален, 2 000 000");
  const h1 = (await all()).filter((m) => m.role === "system" && m.text === "handoff");
  const a1 = (await all()).find((m) => m.role === "assistant");

  // 2) Ещё раз передаёт, менеджер не ответил: новой передачи нет, к прежней дописано; агент знает, что уже передано
  queue.push("Менеджер уже в курсе.\n[[HANDOFF]]");
  await say("А без вертолётной площадки есть?");
  const h2 = (await all()).filter((m) => m.role === "system" && m.text === "handoff");
  const sysAfterHandoff = systems.at(-1) ?? "";

  // 3) Менеджер ответил только что — клиент отвечает ему: агент молчит
  await db.insert(messages).values({ conversationId: conv.id, role: "operator", text: "Подберём эксклюзив!", status: "sent" });
  const calls = systems.length;
  await say("Я как раз к Евгению обращался");
  const silent = systems.length === calls;
  const [c3] = await db.select().from(conversations).where(eq(conversations.id, conv.id));

  // 4) Менеджер писал 20 минут назад — агент снова отвечает; прежняя передача закрыта ответом менеджера
  // Вся переписка сдвигается на 20 минут назад (порядок сообщений тот же)
  await db.update(messages).set({ createdAt: sql`${messages.createdAt} - ${20 * 60_000}` }).where(eq(messages.conversationId, conv.id));
  queue.push("Конечно, расскажу про солнечные панели.");
  await say("А солнечная электростанция?");
  const answered = (await all()).some((m) => m.role === "assistant" && m.text.includes("солнечные панели"));
  const noPendingNote = !(systems.at(-1) ?? "").includes("Разговор уже передан менеджеру");

  // 5) Свой бот спрашивает агента через 10 с после ответа менеджера (ещё не узнал о нём) — разговор остаётся у менеджера
  await db.update(conversations).set({ mode: "human" }).where(eq(conversations.id, conv.id));
  await db.insert(messages).values({ conversationId: conv.id, role: "operator", text: "Пардон, перепутал", status: "sent" });
  const route = await import("@/app/api/agent/[channelId]/route");
  const ask = (text: string) =>
    route.POST(
      new Request(`http://x/api/agent/${ch.id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ user: { id: "handover-user", name: "Анатолий" }, text }),
      }),
      { params: Promise.resolve({ channelId: ch.id }) },
    ).then((r) => r.json());
  const r5 = await ask("Супер, только я не Екатерина");
  const [c5] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
  // …а через 40 минут тишины менеджера бот снова передаёт клиента агенту — тот отвечает
  await db.update(messages).set({ createdAt: new Date(Date.now() - 40 * 60_000) }).where(and(eq(messages.conversationId, conv.id), eq(messages.role, "operator")));
  queue.push("Отвечаю: панели есть в проекте Sierra Verde.");
  const r6 = await ask("Так что с панелями?");

  await db.delete(messages).where(eq(messages.conversationId, conv.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(channels).where(eq(channels.id, ch.id));
  stub.close();

  const checks: Record<string, boolean> = {
    "передача: причина записана": h1.length === 1 && h1[0].meta?.reason === "нет объекта с 5 спальнями",
    "причина не уходит боту в действия": !(a1?.meta?.actions ?? []).some((a) => a.type === "reason"),
    "повторная передача — без новой записи, дописана к прежней": h2.length === 1 && h2[0].meta?.repeats === 1,
    "агент знает, что уже передано": sysAfterHandoff.includes("Разговор уже передан менеджеру"),
    "менеджер только что ответил — агент молчит": silent && c3.needsAttention === true,
    "через 15+ минут — агент снова отвечает": answered && noPendingNote,
    "свой бот не забирает разговор у менеджера, писавшего только что": r5.reply === null && c5.mode === "human",
    "менеджер давно молчит — агент отвечает боту": typeof r6.reply === "string" && r6.reply.includes("Sierra Verde"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
