/** pass^k в автотестах: каждый сценарий прогоняется k раз; нестабильный (провалил хотя бы один прогон) не пройден;
 *  результаты подписаны номером прогона; k сохраняется в прогоне. Модель и судья — заглушка.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-pass-k.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, testResults, testRuns, testScenarios } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  let flaky = 0;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      const judge = JSON.stringify(b.system ?? "").includes("проверяющий качества");
      const prompt = JSON.stringify(b.messages ?? "");
      // Нестабильный сценарий: один из прогонов судья не принимает
      const pass = !(judge && prompt.includes("FLAKY") && ++flaky === 2);
      const text = judge ? JSON.stringify({ verdicts: [{ criterion: "1", pass, comment: pass ? "ок" : "плохо" }], score: pass ? 9 : 3, summary: "—" }) : "Ответ агента";
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
  await new Promise<void>((r) => stub.listen(4085, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4085";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [c] = await db.insert(clients).values({ name: "PassK Test" }).returning();
  const [a] = await db.insert(agents).values({ clientId: c.id, name: "passk-agent", status: "active", config: agentConfigSchema.parse({ model: "anthropic:claude-haiku-5-5" }) }).returning();
  await db.insert(testScenarios).values([
    { agentId: a.id, name: "Стабильный", mode: "script", turns: ["Какие часы работы?"], criteria: [{ text: "1" }] },
    { agentId: a.id, name: "Нестабильный", mode: "script", turns: ["FLAKY вопрос"], criteria: [{ text: "1" }] },
  ] as never);
  const { startRunTracked } = await import("@/lib/tests/engine");
  const run = await startRunTracked(a.id, null, { k: 3 });
  await run.done;
  const [r3] = await db.select().from(testRuns).where(eq(testRuns.id, run.runId));
  const rows = await db.select().from(testResults).where(eq(testResults.runId, run.runId));
  flaky = 10;
  const one = await startRunTracked(a.id, null);
  await one.done;
  const [r1] = await db.select().from(testRuns).where(eq(testRuns.id, one.runId));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "каждый сценарий — 3 прогона, подписаны": rows.length === 6 && rows.some((x) => x.scenarioName === "Нестабильный · 2/3") && r3.k === 3,
    "нестабильный не пройден, стабильный пройден": r3.status === "done" && r3.passed === 1 && r3.total === 2,
    "обычный прогон — как раньше": r1.k === 1 && r1.passed === 2,
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
