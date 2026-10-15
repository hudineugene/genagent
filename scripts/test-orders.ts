/** Агент сопровождает заказ: лента заказа (/order → контекст агента) и живой текст о статусе (модель — заглушка).
 *  Нужен dev-сервер :3005: DB_PATH=<копия caltest> npx tsx scripts/test-orders.ts */
import http from "node:http";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, type ApiConfig } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  // Заглушка модели: первый ответ сохраняет факты, второй — теряет дату
  const replies = [
    "Ліза, беремося за ваш пак з рудим котом! Замовлення #42 уже в роботі, ескізи покажемо до 20.10 🎨",
    "Ліза, беремося за ваш пак з рудим котом! Замовлення #42 уже в роботі.",
  ];
  const seen: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body).messages[0].content);
      const text = JSON.stringify({ text: replies[seen.length - 1] ?? replies[1] });
      // Потоковый ответ (generateJson читает stream)
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
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
  await new Promise<void>((r) => stub.listen(4019, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4019";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const key = (ch.config as ApiConfig).key;
  const user = { id: "order-test-user", name: "Ліза" };
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:3005/api/agent/${ch.id}/order`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  // 1) Бот сообщает статусы (без живого текста) — лента в разговоре
  const r1 = await post({ user, order: { id: "#42", title: "Стікерпак з котом", status: "new", label: "отримано" } });
  const r2 = await post({ user, order: { id: "#42", status: "in_progress", label: "в роботі", facts: "Ескізи до 20.10" }, write: false });
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.channelId, ch.id), eq(conversations.externalId, user.id)));
  const order = conv.context?.orders?.[0];

  // 2) Живой текст: включаем в канале, разговор с агентом есть
  await db.update(channels).set({ config: { ...(ch.config as ApiConfig), orderNotes: true } }).where(eq(channels.id, ch.id));
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Хочу пак з моїм рудим котом", status: "sent" },
    { conversationId: conv.id, role: "assistant", text: "Чудова ідея! Оформіть бриф — і почнемо.", status: "sent" },
  ]);
  const [fresh] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
  const { writeOrderNote, saveOrder, ordersNote, keepsFacts } = await import("@/lib/agent/orders");
  const [chOn] = await db.select().from(channels).where(eq(channels.id, ch.id));
  const fallback = "🎨 Беремося за ваше замовлення #42! Ескізи покажемо до 20.10.";
  const u = { id: "#42", status: "in_progress", label: "в роботі", facts: "Ескізи до 20.10" };
  const good = await writeOrderNote(chOn, fresh, u, fallback);
  const lost = await writeOrderNote(chOn, fresh, u, fallback);
  await saveOrder(fresh, u, good);
  const [note] = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.createdAt)).limit(1);
  // Менеджер ведёт диалог — модель не зовём
  const before = seen.length;
  const manual = await writeOrderNote(chOn, { ...fresh, mode: "human" }, u, fallback);

  // Вернуть канал как был
  await db.update(channels).set({ config: ch.config }).where(eq(channels.id, ch.id));
  const ctx = ordersNote(order ? [order] : []) ?? "";

  const checks: Record<string, boolean> = {
    "без write — текста нет": r1.text === null && r2.text === null,
    "лента заказа: 2 шага, факты, название": order?.steps.length === 2 && order.label === "в роботі" && order.facts === "Ескізи до 20.10" && order.title === "Стікерпак з котом",
    "в контексте агента — заказ и история": ctx.includes("#42") && ctx.includes("отримано") && ctx.includes("в роботі") && ctx.includes("Ескізи до 20.10"),
    "модели дали шаблон и переписку": String(seen[0]).includes(fallback) && String(seen[0]).includes("рудим котом"),
    "живой текст с фактами — принят": good === replies[0],
    "потерял дату — шаблон": lost === null,
    "сообщение агента сохранено": note?.role === "assistant" && note.text === replies[0] && Boolean(note.meta?.orderNote),
    "менеджер ведёт — без модели": manual === null && seen.length === before,
    "проверка фактов": keepsFacts("Замовлення #7 на 1 250 грн, 20.10", "№7, 1 250 грн до 20.10") && !keepsFacts("#7 до 20.10", "№7 скоро") && keepsFacts("Замовлення #0007 готове", "Ваш пак #7 готовий"),
  };
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  stub.close();
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
