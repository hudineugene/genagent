/** Telegram: ответ по мере написания — сразу «Думает…», затем черновики (sendMessageDraft) без служебных меток, итог —
 *  обычным сообщением с кнопками быстрых ответов (метки [[ACTION button: …]] в текст не попадают); выключено у агента
 *  или строгая проверка фактов — черновиков нет; кнопки в Viber — клавиатурой. Telegram, Viber, модель — заглушки.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-streaming.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

const REPLY = ["Добрый день! У нас есть три формата занятий: ", "индивидуальные, групповые и онлайн. ", "Что вам ближе?\n[[ACTION button: Индивидуальные]][[ACTION button: Групповые]][[ACTION button: Онлайн]]"];

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const url = req.url ?? "";
      if (url.startsWith("/bot") || url.startsWith("/pa/")) {
        calls.push({ path: url, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(url.startsWith("/pa/") ? { status: 0, message_token: 1 } : { ok: true, result: true }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }));
      res.write(ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
      for (const part of REPLY) {
        res.write(ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: part } }));
        await new Promise((r) => setTimeout(r, 900));
      }
      res.end(ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }) + ev("message_stop", {}));
    });
  });
  await new Promise<void>((r) => stub.listen(4080, r));
  for (const k of ["TELEGRAM_API_URL", "ANTHROPIC_BASE_URL", "VIBER_URL"]) process.env[k] = "http://127.0.0.1:4080";
  process.env.ANTHROPIC_API_KEY = "test-key";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Stream Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const base = { ...(agent.config as AgentConfig), model: "anthropic:claude-haiku-5-5", answerCheck: false, factGuard: "off" as const, aiDisclosure: undefined, memory: false, quickReplies: true };
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "stream-agent", status: "active", config: { ...base, streaming: true } }).returning();
  const [tg] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "@s", config: { token: "1:x", username: "s", botName: "s" } }).returning();
  const [vb] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "viber", name: "v", config: { token: "vbtoken-1234567890abcdef", botName: "Shop" } }).returning();
  const { respond } = await import("@/lib/conversations");
  const run = async (ch: typeof tg, ext: string) => {
    const [conv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: ch.type, externalId: ext, contactName: "Аня" }).returning();
    await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Какие есть занятия?", createdAt: new Date() } as never);
    await respond(conv.id);
    const [m] = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).then((r) => r.filter((x) => x.role === "assistant"));
    return m;
  };

  const m1 = await run(tg, "1001");
  const drafts = calls.filter((x) => x.path.endsWith("/sendMessageDraft"));
  const final = calls.find((x) => x.path.endsWith("/sendMessage"));
  calls.length = 0;
  await db.update(agents).set({ config: { ...base, streaming: false } }).where(eq(agents.id, a.id));
  await run(tg, "1002");
  const offDrafts = calls.filter((x) => x.path.endsWith("/sendMessageDraft")).length;
  const offAction = calls.some((x) => x.path.endsWith("/sendChatAction"));
  calls.length = 0;
  await db.update(agents).set({ config: { ...base, streaming: true, factGuard: "block" } }).where(eq(agents.id, a.id));
  await run(tg, "1003");
  const strictDrafts = calls.filter((x) => x.path.endsWith("/sendMessageDraft")).length;
  calls.length = 0;
  await db.update(agents).set({ config: { ...base, streaming: false } }).where(eq(agents.id, a.id));
  await run(vb, "vb-user");
  const vbSend = calls.find((x) => x.path === "/pa/send_message");
  const { visibleDraft } = await import("@/lib/channels/telegram-stream");

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const kb = final?.body.reply_markup as { keyboard?: { text: string }[][] } | undefined;
  const r: Record<string, boolean> = {
    "сразу «Думает…», затем черновики с растущим текстом": drafts.length >= 3 && drafts[0].body.text === "" && String(drafts.at(-1)?.body.text).length > String(drafts[1].body.text).length && drafts.every((d) => d.body.draft_id === drafts[0].body.draft_id),
    "в черновиках нет служебных меток": drafts.every((d) => !String(d.body.text).includes("[[")) && visibleDraft("Привет [[ACTION butt") === "Привет",
    "итог — обычным сообщением с кнопками, без меток": Boolean(final) && !String(final?.body.text).includes("[[") && kb?.keyboard?.map((r) => r[0].text).join("|") === "Индивидуальные|Групповые|Онлайн" && m1?.meta?.buttons?.length === 3,
    "выключено у агента — без черновиков, «печатает»": offDrafts === 0 && offAction,
    "строгая проверка фактов — без черновиков": strictDrafts === 0,
    "Viber — кнопки клавиатурой": (vbSend?.body.keyboard as { Buttons: { Text: string }[] } | undefined)?.Buttons.map((b) => b.Text).join("|") === "Индивидуальные|Групповые|Онлайн",
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
