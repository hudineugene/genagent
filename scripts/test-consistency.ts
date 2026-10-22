/** Сверка данных агента: расхождение — в Telegram; те же данные повторно не проверяются; уже известное расхождение
 *  не повторяется; правка данных — новая проверка. Модель и Telegram — заглушки.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-consistency.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: string[] = [];
  let modelCalls = 0;
  let answer: object = { conflicts: [{ item: "Riviera Relleu — цена", values: ["от 95 000 €", "от 96 092 €"], where: "ключевые факты; каталог" }] };
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.includes("/bot")) {
        if (req.url.endsWith("/sendMessage")) sent.push(JSON.parse(body).text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: req.url.endsWith("/getUpdates") ? [] : { message_id: 1 } }));
        return;
      }
      modelCalls++;
      const text = JSON.stringify(answer);
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4042, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4042";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4042";

  const notify = await getSetting("notify");
  await setSetting("notify", { token: "stub", subscribers: [{ chatId: "1" }] });
  const [agent] = await db.select().from(agents).limit(1);
  const cfg = agent.config;
  await db.update(agents).set({ config: { ...cfg, knowledge: "Riviera Relleu (Релеу, от 95 000 €)" } }).where(eq(agents.id, agent.id));
  const stored = await getSetting(`consistency:${agent.id}`);

  const { checkConsistency } = await import("@/lib/agent/consistency");
  const wait = () => new Promise((r) => setTimeout(r, 700));
  const r1 = await checkConsistency(agent.id, { force: true });
  await wait();
  const after1 = { calls: modelCalls, sent: [...sent] };
  const r2 = await checkConsistency(agent.id);
  await wait();
  const after2 = { calls: modelCalls, sent: sent.length };
  // Данные изменились, расхождение то же — модель спрашиваем, но владельцу не повторяем
  await db.update(agents).set({ config: { ...cfg, knowledge: "Riviera Relleu (Релеу, от 95 000 €). Офис в Финестрате." } }).where(eq(agents.id, agent.id));
  await checkConsistency(agent.id);
  await wait();
  const after3 = { calls: modelCalls, sent: sent.length };
  // Исправили — расхождений нет
  answer = { conflicts: [] };
  await db.update(agents).set({ config: { ...cfg, knowledge: "Riviera Relleu (Релеу, от 96 092 €)." } }).where(eq(agents.id, agent.id));
  const r4 = await checkConsistency(agent.id);

  await db.update(agents).set({ config: cfg }).where(eq(agents.id, agent.id));
  const restore = async (k: string, v: unknown) => (v === undefined ? db.delete(settings).where(eq(settings.key, k)) : setSetting(k, v));
  await restore(`consistency:${agent.id}`, stored);
  await restore("notify", notify);
  stub.close();

  const result: Record<string, boolean> = {
    "расхождение найдено и отправлено владельцу": r1?.length === 1 && after1.sent.length === 1 && after1.sent[0].includes("96 092") && after1.sent[0].includes("Расхождение"),
    "те же данные — без повторного запроса к модели": after2.calls === after1.calls && after2.sent === 1 && r2?.length === 1,
    "правка, расхождение то же — владельцу не повторяем": after3.calls === after1.calls + 1 && after3.sent === 1,
    "исправили — расхождений нет": Array.isArray(r4) && r4.length === 0,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
