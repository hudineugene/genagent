/** Процедуры с обязательными шагами: агент запускает start_procedure — первый вопрос пишет программа (вместо текста
 *  модели); неверный ответ — подсказка и повтор; выбор — по номеру; статус заказа из CRM; согласование руководителем —
 *  после «согласовано» процедура продолжается сама и пишет итог с ответами; «отмена» останавливает; модель внутри
 *  процедуры не вызывается. Модель и CRM — заглушки.  DB_PATH=<копия caltest> npx tsx scripts/test-procedures.ts */
import http from "node:http";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvals, channels, clientTools, clients, conversations, messages, procedures } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  process.env.TOOLS_ALLOW_PRIVATE_FOR_TESTS = "1";
  let modelCalls = 0;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/keycrm/order/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: 55, status: { name: "Доставлено" }, grand_total: 900 }));
      }
      if (url.startsWith("/bot")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      const b = JSON.parse(body);
      // Ответ агента (с инструментом процедур), а не фоновые задачи (карточка лида и т. п.)
      if (JSON.stringify(b.tools ?? []).includes("start_procedure")) modelCalls++;
      const last = b.messages.at(-1);
      const toolResult = Array.isArray(last?.content) && last.content.some((c: { type: string }) => c.type === "tool_result");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      if (toolResult) {
        return res.end(start + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Сейчас оформим." } }) + ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) + ev("message_stop", {}));
      }
      res.end(
        start +
          ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_1", name: "start_procedure", input: {} } }) +
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ name: "Возврат" }) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4082, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4082";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.KEYCRM_URL = "http://127.0.0.1:4082/keycrm";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4082";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Procedures Test" }).returning();
  const [crm] = await db.insert(clientTools).values({ clientId: c.id, kind: "crm", name: "crm", title: "KeyCRM", url: "", config: { provider: "keycrm", key: "k" } }).returning();
  const [proc] = await db
    .insert(procedures)
    .values({
      clientId: c.id,
      name: "Возврат",
      trigger: "Клиент хочет вернуть товар",
      steps: [
        { kind: "ask", key: "order", question: "Назовите номер заказа.", type: "number" },
        { kind: "ask", key: "reason", question: "Почему возвращаете?", type: "choice", options: ["Брак", "Не подошёл размер", "Другое"] },
        { kind: "ask", key: "phone", question: "Ваш телефон для связи?", type: "phone" },
        { kind: "tool", toolId: crm.id, action: "order", args: { order: "{order}" }, saveAs: "status" },
        { kind: "approval", subject: "Возврат по заказу {order}", details: "Причина: {reason}. Статус: {status}", rejected: "Возврат по заказу {order} не согласован." },
        { kind: "say", text: "Возврат по заказу {order} оформлен. Курьер позвонит на {phone}." },
      ],
    })
    .returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const cfg = { ...(agent.config as AgentConfig), model: "anthropic:claude-haiku-5-5", answerCheck: false, factGuard: "off" as const, aiDisclosure: undefined, memory: false, procedureIds: [proc.id], toolIds: [] };
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "proc-agent", status: "active", config: cfg }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
  const { respond, addMessage } = await import("@/lib/conversations");
  const mk = async (ext: string) => (await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: ext, contactName: "Оля" }).returning())[0];
  const say = async (convId: string, text: string) => {
    await addMessage(convId, "user", text);
    await respond(convId);
  };
  const replies = async (convId: string) => (await db.select().from(messages).where(eq(messages.conversationId, convId)).orderBy(asc(messages.createdAt))).filter((m) => m.role === "assistant").map((m) => m.text);

  const conv = await mk("p-1");
  await say(conv.id, "Хочу вернуть товар");
  const afterStart = await replies(conv.id);
  const callsAfterStart = modelCalls;
  await say(conv.id, "не помню");
  await say(conv.id, "12345");
  await say(conv.id, "2");
  await say(conv.id, "+380 67 111 22 33");
  const callsInProcedure = modelCalls - callsAfterStart;
  const [appr] = await db.select().from(approvals).where(eq(approvals.conversationId, conv.id));
  const waiting = (await db.select().from(conversations).where(eq(conversations.id, conv.id)))[0].context?.procedure?.waiting;
  const { decideApproval } = await import("@/lib/team/approvals");
  await decideApproval(appr.id, true, "Директор");
  const all = await replies(conv.id);
  const [final] = await db.select().from(conversations).where(eq(conversations.id, conv.id));

  // Отмена
  const conv2 = await mk("p-2");
  await say(conv2.id, "Верните деньги");
  await say(conv2.id, "отмена");
  const r2 = await replies(conv2.id);
  const [c2] = await db.select().from(conversations).where(eq(conversations.id, conv2.id));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const r: Record<string, boolean> = {
    "агент запустил — первый вопрос пишет программа, не модель": afterStart.length === 1 && afterStart[0] === "Назовите номер заказа.",
    "неверный ответ — подсказка и тот же вопрос": all.some((t) => t.startsWith("Нужно число.") && t.includes("Назовите номер заказа.")),
    "вопрос с вариантами, ответ номером": all.some((t) => t.includes("1. Брак") && t.includes("3. Другое")),
    "внутри процедуры модель не вызывается": callsInProcedure === 0,
    "согласование: заявка с ответами и статусом из CRM, ждём решения": appr?.subject === "Возврат по заказу 12345" && appr.details.includes("Не подошёл размер") && appr.details.includes("Доставлено") && waiting === appr.id,
    "после «согласовано» — итог с ответами, процедура закончена": all.at(-1) === "Возврат по заказу 12345 оформлен. Курьер позвонит на +380671112233." && !final.context?.procedure,
    "«отмена» останавливает процедуру": r2.at(-1)?.startsWith("Хорошо, остановил") === true && !c2.context?.procedure,
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
