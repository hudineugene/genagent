/** Журнал переписки своего бота (/sync) на копии базы, через HTTP к dev-серверу :3005: DB_PATH=<копия caltest> npx tsx scripts/test-bot-sync.ts */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, type ApiConfig } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const key = (ch.config as ApiConfig).key;
  const base = `http://127.0.0.1:3005/api/agent/${ch.id}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  };
  const user = { id: "sync-test-user", name: "Тест Журнал" };
  const t0 = Date.now() - 60 * 60 * 1000; // час назад

  // 1. Первая досылка: клиент, бот, стикер, реакция, кнопка, ответ менеджера из бота
  const first = await post("/sync", {
    user,
    items: [
      { id: "in:1", dir: "in", text: "Привет 👋", at: t0 },
      { id: "out:2", dir: "out", text: "Выберите раздел: 🏠 Объекты · 📞 Контакты", at: t0 + 1000 },
      { id: "cb:3", dir: "in", kind: "button", text: "🏠 Объекты", at: t0 + 2000 },
      { id: "in:4", dir: "in", kind: "sticker", text: "😊", at: t0 + 3000 },
      { id: "re:5", dir: "in", kind: "reaction", text: "👍", at: t0 + 4000 },
      { id: "out:6", dir: "out", by: "manager", text: "Здравствуйте! Подскажу по объектам.", at: t0 + 5000 },
    ],
  });
  // 2. Повтор той же пачки — ничего нового
  const again = await post("/sync", { user, items: [{ id: "in:1", dir: "in", text: "Привет 👋", at: t0 }, { id: "out:6", dir: "out", by: "manager", text: "Здравствуйте! Подскажу по объектам.", at: t0 + 5000 }] });

  // 3. Вопрос и ответ агента, уже записанные без номера (как через основной адрес) — журнал их узнаёт
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.channelId, ch.id), eq(conversations.externalId, user.id)));
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Есть виллы у моря?", createdAt: new Date(t0 + 10_000) },
    { conversationId: conv.id, role: "assistant", text: "Да, у моря есть виллы в Бенидорме от 550 000 €.", createdAt: new Date(t0 + 15_000) },
  ]);
  const known = await post("/sync", {
    user,
    items: [
      { id: "in:7", dir: "in", text: "Есть виллы у моря?", at: t0 + 9_000 },
      // бот дописал к ответу агента строку — всё равно тот же ответ
      { id: "out:8", dir: "out", by: "agent", text: "Да, у моря есть виллы в Бенидорме от 550 000 €.\n\n💬 Записаться на просмотр", at: t0 + 16_000 },
    ],
  });

  // 4. /log с номером, потом журнал с тем же номером — одно сообщение
  await post("/log", { user, role: "media", text: "Фотография", messageId: "in:9" });
  const afterLog = await post("/sync", { user, items: [{ id: "in:9", dir: "in", kind: "photo", text: "Фотография", at: Date.now() }] });

  const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
  const byBot = (id: string) => rows.filter((r) => r.botId === id);
  const [convAfter] = await db.select().from(conversations).where(eq(conversations.id, conv.id));
  // Очередь для бота (ответы менеджера, которые надо отправить клиенту) не должна видеть досланное
  const outbox = await (await fetch(`${base}/outbox?kinds=dm`, { headers: { authorization: `Bearer ${key}` } })).json();

  const checks: Record<string, boolean> = {
    "первая досылка: 6 новых": first.inserted === 6,
    "повтор: ничего нового": again.inserted === 0 && again.skipped === 2,
    "вопрос и ответ агента узнаны (без дублей)": known.matched === 2 && known.inserted === 0,
    "текст бота — вид «bot»": byBot("out:2")[0]?.role === "bot",
    "ответ менеджера — operator": byBot("out:6")[0]?.role === "operator",
    "стикер и реакция с видом": byBot("in:4")[0]?.meta?.kind === "sticker" && byBot("re:5")[0]?.meta?.kind === "reaction",
    "/log + журнал с одним номером — одно сообщение": afterLog.inserted === 0 && byBot("in:9").length === 1,
    "время сообщений из журнала сохранено": byBot("in:1")[0]?.createdAt.getTime() === t0,
    "очередь отправки клиенту не трогает досланное": !(outbox.items ?? []).some((i: { id: string }) => rows.some((r) => r.id === i.id)),
    "диалог не переведён на менеджера": convAfter.mode === "ai",
  };
  console.log({ first, again, known, afterLog });
  console.log(checks);
  if (!process.env.KEEP) await db.delete(conversations).where(eq(conversations.id, conv.id));
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
