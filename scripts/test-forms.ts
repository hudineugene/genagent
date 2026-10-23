/** Анкеты и тесты: инструмент анкеты передаётся агенту, в живом режиме ответы сохраняются и уходят менеджеру
 *  в Telegram, у теста считаются баллы и ошибки, в тестовом режиме — не сохраняются; подсказка в инструкции.
 *  Модель и Telegram — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-forms.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientForms, clients, conversations, formResponses, settings } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: string[] = [];
  const results: string[] = [];
  let call: { name: string; input: object } | null = null;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        if (req.url.endsWith("/sendMessage")) tg.push(JSON.parse(body).text);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: req.url.endsWith("/getUpdates") ? [] : { message_id: 1 } }));
      }
      const b = JSON.parse(body);
      const last = b.messages.at(-1);
      const result = Array.isArray(last?.content) ? last.content.find((x: { type: string }) => x.type === "tool_result") : null;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      if (result || !call) {
        if (result) results.push(String(result.content));
        return res.end(start + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Спасибо!" } }) + ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) + ev("message_stop", {}));
      }
      res.end(
        start +
          ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu", name: call.name, input: {} } }) +
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4054, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4054";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4054";
  const notify = await getSetting("notify");
  await setSetting("notify", { token: "stub", subscribers: [{ chatId: "1" }] });

  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id)).limit(1);
  const [conv] = await db.insert(conversations).values({ clientId: client.id, agentId: agent.id, channelId: ch.id, channelType: ch.type, externalId: "form-1", contactName: "Олег" }).returning();
  const [form] = await db
    .insert(clientForms)
    .values({
      clientId: client.id,
      name: "Подбор квартиры",
      purpose: "клиент хочет подбор",
      fields: [
        { key: "budget", label: "Бюджет", type: "number", required: true },
        { key: "rooms", label: "Спальни", type: "choice", options: ["1", "2", "3"], required: true },
        { key: "phone", label: "Телефон", type: "phone", required: false },
      ],
      thanks: "Менеджер напишет в течение дня.",
    })
    .returning();
  const [quiz] = await db
    .insert(clientForms)
    .values({
      clientId: client.id,
      kind: "quiz",
      name: "Тест по продукту",
      fields: [
        { key: "q1", label: "Сколько вилл в Sierra Verde?", type: "number", required: true, correct: "5", points: 2 },
        { key: "q2", label: "Где Riviera 1?", type: "text", required: true, correct: "Финестрат", points: 1 },
      ],
    })
    .returning();

  const { prepareChat } = await import("@/lib/agent/runtime");
  const { streamChat } = await import("@/lib/llm");
  const { formToolName } = await import("@/lib/agent/forms");
  const base = agentConfigSchema.parse(agent.config);
  const config = { ...base, formIds: [form.id, quiz.id], calendar: { ...base.calendar, enabled: false } };
  const run = async (mode: "live" | "dry", c: { name: string; input: object }) => {
    call = c;
    const p = await prepareChat(config, client, [{ role: "user", content: "Подберите квартиру" }], { mode, agentId: agent.id, conversationId: conv.id });
    for await (const e of streamChat({ model: "anthropic:claude-haiku-5-5", effort: "low", system: p.system, messages: p.messages, tools: p.tools })) void e;
    return p;
  };
  const p1 = await run("live", { name: formToolName(form), input: { budget: 250000, rooms: "2", phone: "+34 600 000 000" } });
  await new Promise((r) => setTimeout(r, 800));
  const saved = await db.select().from(formResponses).where(eq(formResponses.formId, form.id));
  await run("live", { name: formToolName(quiz), input: { q1: 5, q2: "в Бенидорме" } });
  const quizSaved = await db.select().from(formResponses).where(eq(formResponses.formId, quiz.id));
  await run("dry", { name: formToolName(form), input: { budget: 100, rooms: "1" } });
  const afterDry = await db.select().from(formResponses).where(eq(formResponses.formId, form.id));
  await new Promise((r) => setTimeout(r, 500));

  await db.delete(clientForms).where(eq(clientForms.id, form.id));
  await db.delete(clientForms).where(eq(clientForms.id, quiz.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  if (notify === undefined) await db.delete(settings).where(eq(settings.key, "notify"));
  else await setSetting("notify", notify);
  stub.close();

  const result: Record<string, boolean> = {
    "анкеты переданы агенту, подсказка в инструкции": Boolean(p1.tools?.some((t) => t.name === formToolName(form))) && p1.system.includes("# Анкеты и тесты") && p1.system.includes("Подбор квартиры"),
    "ответы сохранены": saved.length === 1 && saved[0].answers.budget === "250000" && saved[0].answers.rooms === "2" && saved[0].conversationId === conv.id,
    "агенту — «сохранено» и что сказать": results[0]?.includes("Saved.") && results[0]?.includes("Менеджер напишет"),
    "менеджеру в Telegram — ответы с подписями": tg.some((x) => x.includes("Подбор квартиры") && x.includes("Бюджет: 250000") && x.includes("Спальни: 2")),
    "тест: баллы и ошибки": quizSaved[0]?.score === 2 && quizSaved[0]?.maxScore === 3 && results[1]?.includes("Score: 2 of 3") && results[1]?.includes("correct: Финестрат"),
    "тестовый режим — не сохранено": afterDry.length === 1 && results[2]?.includes("Test mode"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
