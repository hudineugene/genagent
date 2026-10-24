/** Голосовые в нативных Telegram и WhatsApp: скачать голосовое, расшифровать (заглушка вместо модели), агент
 *  отвечает голосовым (OpenAI — заглушка): в Telegram с подписью, в WhatsApp — одним аудио; на текст —
 *  текстом; выключено у агента — текстом. Telegram, Meta, модель — заглушки.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-voice.ts */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { path: string; body: string }[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ path: url, body });
      const json = (o: object) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.includes("/getFile")) return json({ ok: true, result: { file_path: "voice/file1.oga", file_size: 2000 } });
      if (url.includes("/file/bot")) {
        res.writeHead(200);
        return res.end(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(1500, 2)]));
      }
      if (url.startsWith("/bot")) return json({ ok: true, result: { message_id: 77 } });
      if (url.startsWith("/graph/media-1")) return json({ url: "http://127.0.0.1:4074/cdn/voice.ogg", mime_type: "audio/ogg", file_size: 2000 });
      if (url.startsWith("/cdn/")) {
        res.writeHead(200);
        return res.end(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(1500, 3)]));
      }
      if (url.endsWith("/media")) return json({ id: "up-1" });
      if (url.endsWith("/messages")) return json({ messages: [{ id: "wamid.out" }] });
      if (url.includes("/audio/speech")) {
        res.writeHead(200, { "content-type": "audio/ogg" });
        return res.end(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(400, 1)]));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Доставка завтра с 10 до 14." } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4074, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4074";
  process.env.WHATSAPP_GRAPH_URL = "http://127.0.0.1:4074/graph";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4074";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4074/v1";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ASR_TEST_TEXT = "Когда привезёте заказ?";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Voice Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const cfg = { ...(agent.config as object), model: "anthropic:claude-haiku-5-5", answerCheck: false, factGuard: "off", voiceReplies: true, voice: "marin" };
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "voice-agent", status: "active", config: cfg as never }).returning();
  const [tg] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "123:t" } as never }).returning();
  const [wa] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "whatsapp", name: "wa", config: { token: "wa-token", phoneNumberId: "pn-1" } as never }).returning();

  const { handleUpdate } = await import("@/lib/channels/telegram-poller");
  const { respond } = await import("@/lib/conversations");
  const rows = async (convId: string) => db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt));
  const convOf = async (channelId: string, ext: string) => (await db.select().from(conversations).where(eq(conversations.channelId, channelId))).find((x) => x.externalId === ext)!;

  // Telegram: голосовое → расшифровка → ответ голосовым с подписью
  await handleUpdate(tg.id, { update_id: 1, message: { message_id: 10, chat: { id: 555, type: "private" }, from: { id: 555, first_name: "Оля", is_bot: false }, voice: { file_id: "v1", duration: 3, file_size: 2000 } } } as never);
  const tgConv = await convOf(tg.id, "555");
  await respond(tgConv.id);
  const tgRows = await rows(tgConv.id);
  const tgVoice = calls.find((x) => x.path.endsWith("/sendVoice"));
  // Следом клиент пишет текстом — отвечаем текстом
  await db.insert(messages).values({ conversationId: tgConv.id, role: "user", text: "А можно раньше?", createdAt: new Date(Date.now() + 1000) } as never);
  const before = calls.filter((x) => x.path.endsWith("/sendVoice")).length;
  await respond(tgConv.id);
  const textReply = calls.filter((x) => x.path.endsWith("/sendVoice")).length === before && calls.some((x) => x.path.endsWith("/sendMessage"));

  // WhatsApp: аудио → скачать по id → расшифровка → аудио клиенту + текст
  const { handleWhatsApp } = await import("@/app/api/webhooks/whatsapp/route");
  await handleWhatsApp({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn-1" }, contacts: [{ wa_id: "380671112233", profile: { name: "Петро" } }], messages: [{ id: "wamid.in1", from: "380671112233", type: "audio", audio: { id: "media-1", voice: true } }] } }] }] } as never);
  const waConv = await convOf(wa.id, "380671112233");
  await respond(waConv.id);
  const waRows = await rows(waConv.id);
  const waUpload = calls.some((x) => x.path.endsWith("/pn-1/media"));
  const waAudio = calls.some((x) => x.path.endsWith("/pn-1/messages") && x.body.includes('"type":"audio"') && x.body.includes("up-1"));
  const waText = calls.some((x) => x.path.endsWith("/pn-1/messages") && x.body.includes("Доставка завтра"));

  // Выключено у агента — на голосовое отвечаем текстом
  await db.update(agents).set({ config: { ...cfg, voiceReplies: false } as never }).where(eq(agents.id, a.id));
  await handleUpdate(tg.id, { update_id: 2, message: { message_id: 11, chat: { id: 556, type: "private" }, from: { id: 556, first_name: "Ира", is_bot: false }, voice: { file_id: "v2", duration: 2, file_size: 2000 } } } as never);
  const offConv = await convOf(tg.id, "556");
  const voiceBefore = calls.filter((x) => x.path.endsWith("/sendVoice")).length;
  await respond(offConv.id);
  const offText = calls.filter((x) => x.path.endsWith("/sendVoice")).length === voiceBefore;

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const result: Record<string, boolean> = {
    "Telegram: голосовое скачано и расшифровано в текст сообщения": calls.some((x) => x.path.includes("/getFile")) && tgRows.some((m) => m.role === "user" && m.text === "🎤 Когда привезёте заказ?" && m.meta?.kind === "voice"),
    "Telegram: ответ голосовым с текстом подписью": Boolean(tgVoice?.body.includes("Доставка завтра")) && tgRows.some((m) => m.role === "assistant" && m.meta?.spoken === true),
    "на текстовое сообщение — текстом": textReply,
    "WhatsApp: аудио скачано по id и расшифровано": waRows.some((m) => m.role === "user" && m.text === "🎤 Когда привезёте заказ?"),
    "WhatsApp: ответ одним аудио (без платного текста следом), в расходы": waUpload && waAudio && !waText && waRows.some((m) => m.role === "assistant" && m.meta?.spoken === true),
    "голосовые ответы выключены — текстом": offText,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
