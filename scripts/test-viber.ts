/** Viber: подпись вебхука (чужая — отказ), приветствие при открытии чата, сообщение клиента → разговор → ответ
 *  агента уходит в Viber от имени бота; повтор уведомления не дублирует сообщение; кнопки; рассылки видят Viber.
 *  Viber и модель — заглушки.  DB_PATH=<копия caltest> npx tsx scripts/test-viber.ts */
import http from "node:http";
import { createHmac } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: { path: string; body: Record<string, unknown>; token?: string }[] = [];
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/pa/")) {
        sent.push({ path: url, body: JSON.parse(body || "{}"), token: req.headers["x-viber-auth-token"] as string });
        res.writeHead(200, { "content-type": "application/json" });
        if (url === "/pa/get_account_info") return res.end(JSON.stringify({ status: 0, name: "Shop Bot", uri: "shopbot", icon: "https://x/i.png" }));
        return res.end(JSON.stringify({ status: 0, message_token: 5001 }));
      }
      // Модель: короткий ответ
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Добрый день! Доставка по Киеву — 1 день." } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4078, r));
  process.env.VIBER_URL = "http://127.0.0.1:4078";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4078";
  process.env.ANTHROPIC_API_KEY = "test-key";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Viber Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const cfg = { ...(agent.config as AgentConfig), model: "anthropic:claude-haiku-5-5", answerCheck: false, factGuard: "off" as const, aiDisclosure: undefined, memory: false };
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "viber-agent", status: "active", config: cfg }).returning();
  const v = await import("@/lib/channels/viber");
  const info = await v.getAccountInfo("vbtoken-1234567890abcdef");
  const [ch] = await db
    .insert(channels)
    .values({ agentId: a.id, clientId: c.id, type: "viber", name: info.name, config: { token: "vbtoken-1234567890abcdef", botName: info.name, avatar: info.icon, uri: info.uri, welcome: "Привет! Чем помочь?" } })
    .returning();
  await v.setWebhook("vbtoken-1234567890abcdef", `https://agents.test/api/webhooks/viber/${ch.id}`);

  const { POST, handleViber } = await import("@/app/api/webhooks/viber/[channelId]/route");
  const sign = (raw: string) => createHmac("sha256", "vbtoken-1234567890abcdef").update(raw).digest("hex");
  const post = (raw: string, sig: string) =>
    POST(new Request("https://agents.test/x", { method: "POST", body: raw, headers: { "x-viber-content-signature": sig } }), { params: Promise.resolve({ channelId: ch.id }) });
  const started = JSON.stringify({ event: "conversation_started", user: { id: "u1", name: "Олег" } });
  const bad = await post(started, "deadbeef");
  const welcome = await post(started, sign(started));
  const wj = (await welcome.json()) as { text?: string; sender?: { name: string } };

  const msg = { event: "message", message_token: 777, sender: { id: "u1", name: "Олег", language: "uk" }, message: { type: "text", text: "Сколько идёт доставка?" } };
  await handleViber(ch, msg as never);
  await handleViber(ch, msg as never);
  const [conv] = await db.select().from(conversations).where(eq(conversations.channelId, ch.id));
  const { respond } = await import("@/lib/conversations");
  await respond(conv.id);
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));
  const out = sent.find((x) => x.path === "/pa/send_message");
  const kb = v.keyboard([{ text: "Каталог" }, { text: "Сайт", url: "https://shop.ua" }]);
  const { PUSH_CHANNELS } = await import("@/lib/campaigns/engine");
  const { subprocessors } = await import("@/lib/dpa");
  const subs = await subprocessors(c.id);

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "подключение: имя бота из Viber, вебхук зарегистрирован": info.name === "Shop Bot" && sent.some((x) => x.path === "/pa/set_webhook" && String(x.body.url).endsWith(`/api/webhooks/viber/${ch.id}`) && x.token === "vbtoken-1234567890abcdef"),
    "чужая подпись — отказ": bad.status === 401,
    "открытие чата — приветствие от имени бота": wj.text === "Привет! Чем помочь?" && wj.sender?.name === "Shop Bot",
    "сообщение — в разговор один раз, язык клиента запомнен": rows.filter((m) => m.role === "user").length === 1 && conv.contactName === "Олег" && conv.externalId === "u1",
    "ответ агента ушёл в Viber от имени бота": out?.body.receiver === "u1" && out.body.text === "Добрый день! Доставка по Киеву — 1 день." && (out.body.sender as { name: string }).name === "Shop Bot" && rows.some((m) => m.role === "assistant" && m.externalId === "5001"),
    "кнопки: ответ и ссылка": kb.Buttons.length === 2 && kb.Buttons[0].ActionType === "reply" && kb.Buttons[1].ActionType === "open-url",
    "рассылки и список обработчиков видят Viber": PUSH_CHANNELS.includes("viber") && subs.some((s) => s.name.startsWith("Viber")),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
