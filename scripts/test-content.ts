/** Контент-студия: генерация по профилю клиента и базе знаний (варианты одной партии), публикация в Telegram-канал
 *  ботом клиента (HTML, ссылка на пост), ошибки (нет канала, слишком длинно), публикация по расписанию.
 *  Модель и Telegram — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-content.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, contentItems } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string; mode?: string }[] = [];
  let system = "";
  let prompt = "";
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        const b = JSON.parse(body);
        tg.push({ chat: String(b.chat_id), text: b.text, mode: b.parse_mode });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 42, chat: { username: "test_channel" } } }));
      }
      const b = JSON.parse(body);
      system = b.system;
      prompt = b.messages[0].content;
      const data = { variants: [{ title: "Вид на море", text: "**Riviera 2** — 3 спальни и вид на море.\n- сдача 2027\nЗапишитесь на показ!" }, { title: "Семьям", text: "Дом у моря для всей семьи." }, { title: "Лишний", text: "x" }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: JSON.stringify(data) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4058, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4058";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4058";

  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: client.id, type: "telegram", name: "content-bot", config: { token: "123:test" } as never, enabled: false }).returning();

  const { generateContent, publishItem, publishDue } = await import("@/lib/content/studio");
  const rows = await generateContent(client.id, { kind: "post", platform: "telegram", brief: "Пост о Riviera 2", tone: "уверенно", length: "short", variants: 2, useKb: true });
  const [a, b] = rows;
  const noTarget = await publishItem(a.id);
  await db.update(contentItems).set({ channelId: ch.id, target: "@test_channel" }).where(eq(contentItems.id, a.id));
  const ok = await publishItem(a.id);
  const [aAfter] = await db.select().from(contentItems).where(eq(contentItems.id, a.id));
  const post = tg.at(-1);

  await db.update(contentItems).set({ channelId: ch.id, target: "-100123", text: "x".repeat(5000) }).where(eq(contentItems.id, b.id));
  const tooLong = await publishItem(b.id);

  await db.update(contentItems).set({ text: "По расписанию", status: "scheduled", publishAt: new Date(Date.now() - 1000), error: null }).where(eq(contentItems.id, b.id));
  const [future] = await db.insert(contentItems).values({ clientId: client.id, text: "Завтра", status: "scheduled", publishAt: new Date(Date.now() + 86_400_000), channelId: ch.id, target: "@test_channel" }).returning();
  const before = tg.length;
  await publishDue();
  const [bAfter] = await db.select().from(contentItems).where(eq(contentItems.id, b.id));
  const [futureAfter] = await db.select().from(contentItems).where(eq(contentItems.id, future.id));

  await db.delete(contentItems).where(eq(contentItems.clientId, client.id));
  await db.delete(channels).where(eq(channels.id, ch.id));
  stub.close();

  const result: Record<string, boolean> = {
    "в задании модели — клиент, правила площадки, тон, запрет выдумывать": system.includes(client.name) && system.includes("Telegram-канал") && system.includes("уверенно") && system.includes("не выдумывай") && prompt.includes("Riviera 2"),
    "сохранено ровно 2 варианта одной партии": rows.length === 2 && a.batch === b.batch && a.title === "Вид на море" && a.status === "draft",
    "без канала — понятная ошибка": !noTarget.ok && noTarget.error === "no_target",
    "публикация: HTML, канал, ссылка на пост": ok.ok && ok.url === "https://t.me/test_channel/42" && post?.chat === "@test_channel" && post.mode === "HTML" && post.text.includes("<b>Riviera 2</b>") && post.text.includes("• сдача") && aAfter.status === "published",
    "слишком длинный текст — ошибка без отправки": !tooLong.ok && tooLong.error === "too_long",
    "по расписанию: пора — опубликован, завтра — ждёт": bAfter.status === "published" && futureAfter.status === "scheduled" && tg.length === before + 1 && tg.at(-1)?.text === "По расписанию",
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
