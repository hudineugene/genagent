/** Проверка после изменений: прогон только изменившихся агентов, сообщение только о проблемах, лимит в сутки
 *  (модель и Telegram — заглушки). DB_PATH=<копия caltest> npx tsx scripts/test-auto-tests.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, settings, testRuns, testScenarios } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  let judgePass = true;
  let modelCalls = 0;
  const sent: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (String(req.url).includes("/bot")) {
        if (String(req.url).endsWith("/sendMessage")) sent.push(String(JSON.parse(body).text));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        return;
      }
      modelCalls++;
      const sys = JSON.stringify(JSON.parse(body).system ?? "");
      const isJudge = sys.includes("проверяющий качества");
      const text = isJudge
        ? JSON.stringify({ verdicts: [{ criterion: "1", pass: judgePass, comment: judgePass ? "ок" : "повторил ответ" }], score: judgePass ? 9 : 4, summary: judgePass ? "ок" : "Повторил прежний ответ" })
        : "Ответ агента";
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
  await new Promise<void>((r) => stub.listen(4028, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4028";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4028";

  const keep = await db.select().from(settings).where(inArray(settings.key, ["notify", "autoTests"]));
  const notify = { token: "123:TEST", botUsername: "t_bot", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "QA", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value: notify, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: notify } });
  await db.delete(settings).where(eq(settings.key, "autoTests"));

  // Один агент со сценарием, остальные — без (их не трогаем)
  const [agent] = await db.select().from(agents).where(eq(agents.status, "active")).limit(1);
  const oldScen = await db.select().from(testScenarios);
  await db.delete(testScenarios);
  await db.update(agents).set({ updatedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(agents.id, agent.id));
  await db.insert(testScenarios).values({ agentId: agent.id, name: "Повтор", mode: "script", turns: ["Как купить?", "Как купить?"], criteria: [{ text: "Не повторил ответ" }] });
  const auto = await import("@/lib/tests/auto");
  const runsOf = async () => (await db.select().from(testRuns).where(eq(testRuns.agentId, agent.id))).length;
  const runs0 = await runsOf();

  // 1) Агента ещё не проверяли — прогон; всё прошло — сообщения нет
  const n1 = await auto.runAutoTests();
  const runs1 = await runsOf();
  const msgs1 = sent.length;

  // 2) Ничего не изменилось — прогона нет, модель не зовём
  const calls = modelCalls;
  const n2 = await auto.runAutoTests();
  const idle = n2 === 0 && modelCalls === calls;

  // 3) Правка только что — ждём, пока правки улягутся
  const cfg = agent.config;
  await db.update(agents).set({ config: { ...cfg, rules: `${cfg.rules}\nНовое правило.` }, updatedAt: new Date() }).where(eq(agents.id, agent.id));
  const n3 = await auto.runAutoTests();

  // 4) Через 10+ минут — прогон; судья нашёл проблему — сообщение в Telegram
  await db.update(agents).set({ updatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(agents.id, agent.id));
  judgePass = false;
  const n4 = await auto.runAutoTests();
  const report = sent.at(-1) ?? "";

  // 5) Лимит: третий прогон за сутки ещё можно, четвёртый — нет
  await db.update(agents).set({ config: { ...cfg, rules: `${cfg.rules}\nЕщё правило.` } }).where(eq(agents.id, agent.id));
  const n5 = await auto.runAutoTests();
  await db.update(agents).set({ config: { ...cfg, rules: `${cfg.rules}\nИ ещё.` } }).where(eq(agents.id, agent.id));
  const n6 = await auto.runAutoTests();

  // Выключено — ничего
  await auto.saveAutoTests({ enabled: false, runs: {} });
  await db.update(agents).set({ config: cfg }).where(eq(agents.id, agent.id));
  const n7 = await auto.runAutoTests();

  // Вернуть как было
  await db.update(agents).set({ config: cfg, updatedAt: agent.updatedAt }).where(eq(agents.id, agent.id));
  await db.delete(testScenarios);
  if (oldScen.length) await db.insert(testScenarios).values(oldScen);
  await db.delete(testRuns).where(eq(testRuns.agentId, agent.id));
  await db.delete(settings).where(inArray(settings.key, ["notify", "autoTests"]));
  for (const k of keep) await db.insert(settings).values(k);
  stub.close();

  const checks: Record<string, boolean> = {
    "новый агент — прогон, всё прошло — без сообщения": n1 === 1 && runs1 === runs0 + 1 && msgs1 === 0,
    "без изменений — прогона нет": idle,
    "правка только что — ждём": n3 === 0,
    "проблема — сообщение с названием сценария": n4 === 1 && report.includes("есть проблемы") && report.includes("Повтор") && report.includes("1/1") === false,
    "не больше 3 прогонов в сутки": n5 === 1 && n6 === 0,
    "выключено — ничего": n7 === 0,
  };
  console.log(checks, { n1, n3, n4, n5, n6, n7, report: report.slice(0, 300) });
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
