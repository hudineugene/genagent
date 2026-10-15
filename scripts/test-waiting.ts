/** Напоминания «клиент ждёт человека» и выжимка действий в боте для агента — на копии базы (Telegram — заглушка, без ИИ):
 *  DB_PATH=<копия caltest> npx tsx scripts/test-waiting.ts */
import http from "node:http";
import { eq, like } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { channels, conversations, messages, settings } from "@/db/schema";
import { syncBotMessages } from "@/lib/channels/bot-sync";
import { botActivity } from "@/lib/conversations";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const sent: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (body) sent.push(JSON.parse(body).text ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(4017, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4017";
  const [oldNotify] = await db.select().from(settings).where(eq(settings.key, "notify"));
  const notifyValue = { token: "1:T", botUsername: "b", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "7", name: "QA", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value: notifyValue, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: notifyValue } });

  // Полдень по Киеву сегодня — рабочие часы
  const noon = new Date();
  noon.setUTCHours(9, 0, 0, 0);
  const now = noon.getTime();
  const min = 60_000;
  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "api", externalId: "waiting-test", contactName: "Ждущий", mode: "human", needsAttention: true })
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Когда будет готово?", createdAt: new Date(now - 25 * min) },
  ]);
  const { runWaitingReminders } = await import("@/lib/agent/waiting");

  // В копии базы есть и другие ждущие диалоги — считаем только напоминания по нашему клиенту
  const ours = () => sent.filter((t) => t.includes("Ждущий"));
  await runWaitingReminders(now);
  const first = ours().length;
  const firstText = ours().at(-1) ?? "";
  await runWaitingReminders(now + 2 * min);
  const again = ours().length - first;
  await runWaitingReminders(now + 40 * min); // 65 минут ожидания
  const second = ours().length - first - again;
  const secondText = ours().at(-1) ?? "";
  // Ответ менеджера пришёл журналом из бота → ожидание снято
  await syncBotMessages(conv.id, [{ id: "out:w1", dir: "out", by: "manager", text: "Завтра к обеду", at: now + 41 * min }]);
  const [afterAnswer] = await db.select({ n: conversations.needsAttention }).from(conversations).where(eq(conversations.id, conv.id));
  // Реакция клиента после ответа — не новый вопрос
  await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, conv.id));
  await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "👍", meta: { kind: "reaction" }, createdAt: new Date(now + 42 * min) });
  const before = ours().length;
  await runWaitingReminders(now + 100 * min);
  const afterReaction = ours().length - before;
  // Ночью — не шлём
  await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "А ещё вопрос", createdAt: new Date(now + 101 * min) });
  const night = new Date(noon);
  night.setUTCHours(22, 0, 0, 0); // 01:00 по Киеву
  const beforeNight = ours().length;
  await runWaitingReminders(night.getTime());
  const atNight = ours().length - beforeNight;

  // Выжимка для агента: что бот показал и что нажал клиент после ответа агента
  const activity = botActivity([
    { role: "assistant", text: "Есть виллы в Финестрате.", createdAt: new Date(Date.now() - 10 * min) },
    { role: "bot", text: "🏡 Sierra Verde — виллы с бассейном, от 550 000 €\n\n[Записаться · Подробнее]", createdAt: new Date(Date.now() - 8 * min) },
    { role: "user", text: "Записаться", meta: { kind: "button" }, createdAt: new Date(Date.now() - 7 * min) },
    { role: "user", text: "👍", meta: { kind: "reaction" }, createdAt: new Date(Date.now() - 6 * min) },
    { role: "user", text: "А на субботу можно?", createdAt: new Date(Date.now() - 1 * min) },
  ]);

  const checks: Record<string, boolean> = {
    "через 25 мин — одно напоминание ⏳": first === 1 && firstText.includes("Клиент ждёт ответа 25 мин") && firstText.includes("Когда будет готово?"),
    "повтор сразу не шлём": again === 0,
    "через час — 🔴": second === 1 && secondText.startsWith("🔴") && secondText.includes("1 ч 5 мин"),
    "ответ менеджера из бота снял ожидание": afterAnswer.n === false,
    "реакция клиента — не вопрос": afterReaction === 0,
    "ночью не шлём": atNight === 0,
    "выжимка: что бот показал": Boolean(activity?.includes("Бот показал: 🏡 Sierra Verde")),
    "выжимка: кнопка и реакция": Boolean(activity?.includes("Клиент нажал кнопку «Записаться»") && activity.includes("реакцию 👍")),
    "выжимка: вопрос клиента не дублируется": !activity?.includes("на субботу"),
  };
  console.log(activity);
  console.log(checks);

  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(settings).where(like(settings.key, "waiting:%"));
  if (oldNotify) await db.update(settings).set({ value: oldNotify.value }).where(eq(settings.key, "notify"));
  else await db.delete(settings).where(eq(settings.key, "notify"));
  server.close();
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
