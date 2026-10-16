/** Тестовые аккаунты: разметка разговоров и исключение из статистики/обучения.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-test-accounts.ts */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, settings } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { normalizeAccount, saveTestAccounts, isTestAccount } = await import("@/lib/test-accounts");
  const { upsertConversation } = await import("@/lib/conversations");
  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const [savedList] = await db.select().from(settings).where(eq(settings.key, "testAccounts"));
  const stamp = Date.now();
  const old = await upsertConversation(ch, `9${stamp}`.slice(0, 12), { name: "Владелец", handle: "@Owner_Test" });
  const other = await upsertConversation(ch, `8${stamp}`.slice(0, 12), { name: "Клиент" });
  await db.insert(messages).values({ conversationId: old.conversation.id, role: "user", text: "Тестирую бота", status: "sent" });
  await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, old.conversation.id));

  const saved = await saveTestAccounts(`@owner_test, https://t.me/Staff_Two  7${stamp}`.slice(0, 60) + " ???");
  const [oldAfter] = await db.select().from(conversations).where(eq(conversations.id, old.conversation.id));
  const [otherAfter] = await db.select().from(conversations).where(eq(conversations.id, other.conversation.id));
  // Новый разговор с ID из списка — сразу тестовый
  const staffId = saved.list.find((a) => /^\d+$/.test(a)) ?? "";
  const fresh = await upsertConversation(ch, staffId, { name: "Сотрудник" });

  const { dashboardData } = await import("@/lib/dashboard");
  const dash = await dashboardData();
  const inWaiting = dash.waiting.some((w) => w.id === old.conversation.id);

  // Вернуть как было
  await db.delete(conversations).where(inArray(conversations.id, [old.conversation.id, other.conversation.id, fresh.conversation.id]));
  if (savedList) await db.update(settings).set({ value: savedList.value }).where(eq(settings.key, "testAccounts"));
  else await db.delete(settings).where(eq(settings.key, "testAccounts"));

  const checks: Record<string, boolean> = {
    "разбор: ID, @ник, ссылка t.me, почта": normalizeAccount("123456789") === "123456789" && normalizeAccount("@Ab_cd") === "@ab_cd" && normalizeAccount("https://t.me/Staff_Two") === "@staff_two" && normalizeAccount("A@B.com") === "a@b.com",
    "мусор не принимаем": saved.bad.includes("???"),
    "старые разговоры размечены": oldAfter.isTest === true && saved.marked >= 1,
    "чужой разговор не тронут": otherAfter.isTest === false,
    "новый разговор с тестового ID — сразу тестовый": fresh.conversation.isTest === true,
    "совпадение по нику без @": isTestAccount(["@owner_test"], "1", "Owner_Test"),
    "«Сегодня»: тестовый не в «ждут человека»": !inWaiting,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
