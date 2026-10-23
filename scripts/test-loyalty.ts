/** Баллы: контакты нормализуются, API с ключом начисляет (с приветственным бонусом) и не уходит в минус,
 *  клиенту приходит сообщение в чат, агент видит баланс и обменивает баллы (менеджеру — уведомление),
 *  два одновременных обмена не списывают дважды. Telegram — макет. DB_PATH=<копия caltest> npx tsx scripts/test-loyalty.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, loyaltyAccounts, loyaltyPrograms, loyaltyTx, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      if (req.url?.endsWith("/sendMessage")) tg.push({ chat: String(b.chat_id), text: b.text });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(4060, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4060";
  const notify = await getSetting("notify");

  const { normContact, loyaltyTools } = await import("@/lib/loyalty/engine");
  const norms = [normContact("@Ivan_P"), normContact("+380 (67) 123-45-67"), normContact("Ivan@Mail.com"), normContact("dm:123456"), normContact("  ")];

  const [agent] = await db.select().from(agents).limit(1);
  await setSetting("notify", { token: "stub", botUsername: "n", linkCode: "x", adminUrl: "", subscribers: [{ chatId: "900", name: "studio", since: 0 }], owners: [] });
  const [p] = await db
    .insert(loyaltyPrograms)
    .values({ clientId: agent.clientId, name: "Бонусы Тест", unit: "баллов", rules: "5% от покупки", rewards: [{ name: "Бесплатный кофе", cost: 100 }, { name: "Скидка 10%", cost: 500 }], welcome: 50, apiKey: "lp_test_key_123" })
    .returning();
  const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "telegram", name: "loy-tg", config: { token: "123:test" } as never, enabled: false }).returning();
  const [conv] = await db.insert(conversations).values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: "telegram", externalId: "5551", contactName: "Иван", contactHandle: "@Ivan_P" }).returning();

  const route = await import("@/app/api/loyalty/[programId]/route");
  const ctx = { params: Promise.resolve({ programId: p.id }) };
  const post = (key: string, body: object) =>
    route.POST(new Request(`http://x/api/loyalty/${p.id}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
  const bad = await post("lp_wrong", { contact: "@ivan_p", delta: 10 });
  const r1 = await (await post("lp_test_key_123", { contact: "@Ivan_P", name: "Иван", delta: 100, reason: "Покупка №1" })).json();
  const over = await post("lp_test_key_123", { contact: "@ivan_p", delta: -1000 });
  const get = await (await route.GET(new Request(`http://x/api/loyalty/${p.id}?contact=@IVAN_P`, { headers: { authorization: "Bearer lp_test_key_123" } }), ctx)).json();

  // Агент: баланс и обмен (счёт найден по нику собеседника, разговор привязывается)
  const tools = loyaltyTools(p, { mode: "live", agentId: agent.id, conversationId: conv.id, clientId: agent.clientId });
  const balance = await tools[0].run({});
  const [acc] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.programId, p.id));
  const r2 = await (await post("lp_test_key_123", { contact: "@ivan_p", delta: 20, reason: "Отзыв" })).json();
  const chatMsg = tg.find((x) => x.chat === "5551" && x.text.includes("+20 баллов"));
  const redeemBoth = await Promise.all([tools[1].run({ reward: "бесплатный кофе" }), tools[1].run({ reward: "Бесплатный кофе" })]);
  await new Promise((r) => setTimeout(r, 300));
  const [after] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.id, acc.id));
  const tx = await db.select().from(loyaltyTx).where(eq(loyaltyTx.accountId, acc.id));
  const tooMuch = await tools[1].run({ reward: "Скидка 10%" });
  const unknown = await tools[1].run({ reward: "Яхта" });
  const dry = await loyaltyTools(p, { mode: "dry", clientId: agent.clientId }).at(1)!.run({ reward: "Скидка 10%" });

  await db.delete(loyaltyPrograms).where(eq(loyaltyPrograms.id, p.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(channels).where(eq(channels.id, ch.id));
  if (notify === undefined) await db.delete(settings).where(eq(settings.key, "notify"));
  else await setSetting("notify", notify);
  stub.close();

  const result: Record<string, boolean> = {
    "контакты: ник, телефон, почта, id": norms.join("|") === "ivan_p|380671234567|ivan@mail.com|123456|",
    "API: неверный ключ — 401": bad.status === 401,
    "API: счёт создан с приветственным бонусом": r1.balance === 150 && get.balance === 150 && get.exists === true,
    "API: в минус нельзя (409)": over.status === 409,
    "агент: баланс и награды, счёт найден по нику": balance.includes("Balance: 150 баллов") && balance.includes("Бесплатный кофе") && acc.conversationId === conv.id,
    "клиенту в чат — сообщение о начислении": Boolean(chatMsg) && chatMsg!.text.includes("Ваш баланс: 170 баллов") && r2.balance === 170,
    "два одновременных обмена при балансе на один: списан один": redeemBoth.filter((x) => x.startsWith("Done")).length === 1 && redeemBoth.filter((x) => x.startsWith("Not enough")).length === 1 && after.balance === 70 && tx.filter((t) => t.source === "agent").length === 1,
    "менеджеру — уведомление об обмене": tg.some((x) => x.chat === "900" && x.text.includes("Обмен баллов") && x.text.includes("Бесплатный кофе")),
    "не хватает, неизвестная награда, тестовый режим": tooMuch.startsWith("Not enough") && unknown.startsWith("Unknown reward") && dry.startsWith("[Test mode"),
  };
  console.log(result, { balance: after.balance });
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
