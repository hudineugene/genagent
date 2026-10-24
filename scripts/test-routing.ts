/** Распределение заявок: тема выбирается по причине и выжимке, уведомление — только ответственным (студия или
 *  владелец), тема запоминается в разговоре и следующие сообщения идут тем же людям; без правил или если
 *  ответственный отписался — всем. Модель и Telegram — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-routing.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, routingRules, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  let classifications = 0;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        const b = JSON.parse(body || "{}");
        if (req.url.endsWith("/sendMessage")) {
          if (String(b.chat_id) === "999") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
          }
          tg.push({ chat: String(b.chat_id), text: b.text });
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      classifications++;
      const b = JSON.parse(body);
      const p = String(b.messages[0].content);
      const topic = /ремонт|сломал|жалоб/i.test(p) ? "Сервис" : /купить|цена|просмотр/i.test(p) ? "Продажи" : "другое";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: JSON.stringify({ topic }) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4066, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4066";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4066";
  const notify = await getSetting("notify");

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Routing Test" }).returning();
  const [plain] = await db.insert(clients).values({ name: "No Rules" }).returning();
  await setSetting("notify", {
    token: "stub",
    botUsername: "n",
    linkCode: "x",
    adminUrl: "",
    subscribers: [
      { chatId: "100", name: "Анна (продажи)", since: 0 },
      { chatId: "200", name: "Борис (сервис)", since: 0 },
    ],
    owners: [{ chatId: "300", name: "Владелец", since: 0, clientId: c.id }],
  });
  await db.insert(routingRules).values([
    { clientId: c.id, name: "Продажи", description: "покупка, цены, просмотры", chatIds: ["100", "300"], position: 1 },
    { clientId: c.id, name: "Сервис", description: "ремонт, жалобы", chatIds: ["999"], position: 2 },
  ]);
  const mk = async (clientId: string, ext: string) => {
    const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId, type: "widget", name: "w", config: {} as never }).returning();
    return (await db.insert(conversations).values({ clientId, agentId: agent.id, channelId: ch.id, channelType: "widget", externalId: ext, contactName: "Клиент" }).returning())[0];
  };
  const sales = await mk(c.id, "r1");
  const service = await mk(c.id, "r2");
  const other = await mk(plain.id, "r3");

  const n = await import("@/lib/notify/telegram");
  await n.notifyHandoff(sales.id, "Хочет купить апартаменты и записаться на просмотр", { reason: "запись на просмотр" });
  const afterHandoff = tg.splice(0);
  const [salesConv] = await db.select().from(conversations).where(eq(conversations.id, sales.id));
  const before = classifications;
  await n.notifyClientMessage(sales.id, "Во сколько можно приехать?");
  const afterMsg = tg.splice(0);
  const clsAfterMsg = classifications;
  await n.notifyHandoff(service.id, "Сломался кондиционер, жалоба", { reason: "ремонт" });
  const afterService = tg.splice(0);
  await n.notifyHandoff(other.id, "Вопрос", { reason: "вопрос" });
  const afterPlain = tg.splice(0);

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(clients).where(eq(clients.id, plain.id));
  if (notify === undefined) await db.delete(settings).where(eq(settings.key, "notify"));
  else await setSetting("notify", notify);
  stub.close();

  const chats = (l: { chat: string }[]) => l.map((x) => x.chat).sort().join(",");
  const result: Record<string, boolean> = {
    "передача о покупке — только «Продажи» (сотрудник и владелец)": chats(afterHandoff) === "100,300" && afterHandoff.every((x) => x.text.includes("Продажи")),
    "тема запомнена в разговоре": salesConv.context?.assignedTo?.rule === "Продажи",
    "следующее сообщение клиента — тем же людям, без повторного определения темы": chats(afterMsg) === "100,300" && clsAfterMsg === before,
    "ответственный отписался от бота — уведомление всем": chats(afterService) === "100,200",
    "у клиента без правил — всем сотрудникам студии": chats(afterPlain) === "100,200",
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
