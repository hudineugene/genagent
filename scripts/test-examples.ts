/** Удачные ответы как образец стиля: отбор, исключения, «убрать», попадание в инструкцию агента.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-examples.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, settings } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [agent] = await db.select().from(agents).where(eq(agents.id, ch.agentId));
  const [client] = await db.select().from(clients).where(eq(clients.id, ch.clientId));
  await db.delete(settings).where(eq(settings.key, `examples:${agent.id}`));
  const now = Date.now();
  const mk = async (isTest: boolean, pairs: [string, string, object?][]) => {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "api", externalId: `ex-${now}-${isTest}`, isTest, lastMessageAt: new Date(now) })
      .returning();
    const ids: string[] = [];
    let t = now - 3600_000;
    for (const [q, a, meta] of pairs) {
      await db.insert(messages).values({ conversationId: c.id, role: "user", text: q, status: "sent", createdAt: new Date((t += 1000)) });
      const [m] = await db.insert(messages).values({ conversationId: c.id, role: "assistant", text: a, status: "sent", createdAt: new Date((t += 1000)), meta: meta ?? null }).returning();
      ids.push(m.id);
    }
    return { c, ids };
  };
  const real = await mk(false, [
    ["Сколько стоит пак?", "Пак на 10 стикеров — от 2000 грн. Сделаем за 5–7 дней, эскизы покажем заранее 🙂", { rating: "up" }],
    ["А анимированные бывают?", "Да! Анимированные стикеры оживляют героя — пак из 10 штук от 3500 грн, срок около двух недель.", { qa: { ok: true, at: now } }],
    ["Позовите менеджера", "Передаю вас менеджеру — он ответит в течение часа, хорошо?", { rating: "up", handoff: true }],
    ["Как связаться?", "Звоните нам: +380 67 123 45 67 — ответим с 10 до 19, будем рады помочь.", { rating: "up" }],
    ["Привет", "Здравствуйте!", { rating: "up" }],
    ["Что ещё делаете?", "Ещё делаем маскотов и ботов с Mini App — расскажу подробнее, если интересно."],
  ]);
  const test = await mk(true, [["Тестовый вопрос владельца", "Тестовый ответ, который очень понравился владельцу, но это тест.", { rating: "up" }]]);

  const { refreshExamples, getExamples, hideExample, examplesNote } = await import("@/lib/agent/examples");
  const n = await refreshExamples(agent.id);
  const items = await getExamples(agent.id);
  await hideExample(agent.id, real.ids[0]);
  const afterHide = await getExamples(agent.id);
  await refreshExamples(agent.id);
  const afterRefresh = await getExamples(agent.id);

  const { prepareChat } = await import("@/lib/agent/runtime");
  const cfg = agentConfigSchema.parse(agent.config);
  const withId = await prepareChat(cfg, { ...client, id: client.id }, [{ role: "user", content: "Привет" }], { mode: "dry", agentId: agent.id });
  const without = await prepareChat(cfg, { ...client, id: client.id }, [{ role: "user", content: "Привет" }], { mode: "dry" });

  await db.delete(conversations).where(eq(conversations.id, real.c.id));
  await db.delete(conversations).where(eq(conversations.id, test.c.id));
  await db.delete(settings).where(eq(settings.key, `examples:${agent.id}`));

  const texts = items.map((i) => i.answer).join(" | ");
  const checks: Record<string, boolean> = {
    "взяты 👍 и прошедшие проверку": n === 2 && texts.includes("2000 грн") && texts.includes("Анимированные"),
    "👍 — первым": items[0]?.liked === true,
    "без передач менеджеру, контактов, коротких и неоценённых": !/Передаю|\+380|Здравствуйте!|маскотов/.test(texts),
    "тестовые разговоры не берём": !texts.includes("Тестовый ответ"),
    "«убрать» — сразу и навсегда": afterHide.length === 1 && afterRefresh.length === 1 && !afterRefresh.some((i) => i.id === real.ids[0]),
    "образцы в инструкции агента": withId.system.includes("Удачные ответы — образец стиля") && withId.system.includes("Анимированные"),
    "тест-чат без образцов": !without.system.includes("Удачные ответы"),
    "текст раздела": (examplesNote(items) ?? "").includes("Факты (цены, сроки, наличие) бери только из базы знаний"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
