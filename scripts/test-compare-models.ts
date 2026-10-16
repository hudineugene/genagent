/** Сравнение моделей в автотестах: прогон на другой модели (агент не меняется), судья тот же (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-compare-models.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, testRuns, testScenarios } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { model: string; judge: boolean }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      const judge = JSON.stringify(b.system ?? "").includes("проверяющий качества");
      calls.push({ model: String(b.model), judge });
      const text = judge ? JSON.stringify({ verdicts: [{ criterion: "1", pass: true, comment: "ок" }], score: 9, summary: "ок" }) : "Ответ агента";
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4031, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4031";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [agent] = await db.select().from(agents).where(eq(agents.status, "active")).limit(1);
  // Только свой сценарий на время проверки (остальные сценарии агента вернём после)
  const keep = await db.select().from(testScenarios).where(eq(testScenarios.agentId, agent.id));
  await db.delete(testScenarios).where(eq(testScenarios.agentId, agent.id));
  const [sc] = await db.insert(testScenarios).values({ agentId: agent.id, name: "Сравнение", mode: "script", turns: ["Привет"], criteria: [{ text: "Поздоровался" }] }).returning();
  const { startRunTracked } = await import("@/lib/tests/engine");

  const cmp = await startRunTracked(agent.id, null, { model: "anthropic:claude-sonnet-5-5" });
  await cmp.done;
  const cmpCalls = calls.splice(0);
  const base = await startRunTracked(agent.id, null);
  await base.done;
  const baseCalls = calls.splice(0);
  const [cmpRun] = await db.select().from(testRuns).where(eq(testRuns.id, cmp.runId));
  const [baseRun] = await db.select().from(testRuns).where(eq(testRuns.id, base.runId));
  const [after] = await db.select().from(agents).where(eq(agents.id, agent.id));
  const agentModel = agent.config.model.split(":")[1];

  await db.delete(testRuns).where(eq(testRuns.id, cmp.runId));
  await db.delete(testRuns).where(eq(testRuns.id, base.runId));
  await db.delete(testScenarios).where(eq(testScenarios.id, sc.id));
  if (keep.length) await db.insert(testScenarios).values(keep);
  stub.close();

  const checks: Record<string, boolean> = {
    "сравнение: агент отвечает другой моделью": cmpCalls.filter((c) => !c.judge).length > 0 && cmpCalls.filter((c) => !c.judge).every((c) => c.model === "claude-sonnet-5-5"),
    "судья — прежний": cmpCalls.some((c) => c.judge && c.model === "claude-haiku-5-5"),
    "модель записана в прогон": cmpRun.model === "anthropic:claude-sonnet-5-5" && cmpRun.status === "done",
    "обычный прогон — модель агента, без отметки": baseRun.model === null && baseCalls.filter((c) => !c.judge).every((c) => c.model === agentModel),
    "агент не изменился": after.config.model === agent.config.model && after.version === agent.version,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
