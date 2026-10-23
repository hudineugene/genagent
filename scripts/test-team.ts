/** Агенты для сотрудников: доступ по списку (посторонним — один отказ без модели), подсказка и инструмент заявки,
 *  заявка уходит владельцу с кнопками, решение руководителя приходит сотруднику в чат; в тестовом режиме заявка
 *  не создаётся. Модель и Telegram — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-team.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvals, channels, clients, conversations, messages, settings } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string; markup?: unknown }[] = [];
  let modelCalls = 0;
  let lastSystem = "";
  let call: { name: string; input: object } | null = null;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const start = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        if (req.url.endsWith("/sendMessage")) {
          const b = JSON.parse(body);
          tg.push({ chat: String(b.chat_id), text: b.text, markup: b.reply_markup });
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      modelCalls++;
      const b = JSON.parse(body);
      lastSystem = typeof b.system === "string" ? b.system : JSON.stringify(b.system);
      const last = b.messages.at(-1);
      const result = Array.isArray(last?.content) ? last.content.find((x: { type: string }) => x.type === "tool_result") : null;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (result || !call) {
        return res.end(start + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Заявку отправил руководителю." } }) + ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) + ev("message_stop", {}));
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
  await new Promise<void>((r) => stub.listen(4057, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4057";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4057";
  const notify = await getSetting("notify");

  const { isAllowed } = await import("@/lib/team/approvals");
  const list = "@Ivan_Petrov\n+380 67 123 45 67\n987654321";
  const allow = [
    isAllowed(list, { externalId: "111", handle: "@ivan_petrov" }),
    isAllowed(list, { externalId: "380671234567", handle: "" }),
    isAllowed(list, { externalId: "987654321", handle: "@someone" }),
    !isAllowed(list, { externalId: "1987654321", handle: "@hacker" }),
    !isAllowed(list, { externalId: "222", handle: "@ivan" }),
    isAllowed("*", { externalId: "x", handle: "" }),
    !isAllowed("", { externalId: "x", handle: "" }),
  ];

  for (const old of await db.select({ id: agents.id }).from(agents).where(eq(agents.name, "team-test"))) {
    await db.delete(approvals).where(eq(approvals.agentId, old.id));
    await db.delete(agents).where(eq(agents.id, old.id));
  }
  const [base] = await db.select().from(agents).limit(1);
  const cfg = agentConfigSchema.parse(base.config);
  const team = { enabled: true, allowed: "@ivan_petrov", denyText: "Только для сотрудников «Тест».", approvals: true, approvers: "owners" as const };
  const { id: _id, ...rest } = base;
  void _id;
  const [agent] = await db
    .insert(agents)
    .values({ ...rest, name: "team-test", status: "active", config: { ...cfg, team, answerCheck: false, operatorReview: false, memory: false, calendar: { ...cfg.calendar, enabled: false } } })
    .returning();
  await setSetting("notify", { token: "stub", botUsername: "n", linkCode: "x", adminUrl: "", subscribers: [{ chatId: "900", name: "studio", since: 0 }], owners: [{ chatId: "777", name: "Владелец", since: 0, clientId: agent.clientId }] });
  const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "telegram", name: "team-tg", config: { token: "123:test" } as never }).returning();
  const { addMessage, respond } = await import("@/lib/conversations");
  const mk = async (ext: string, handle: string) =>
    (await db.insert(conversations).values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: "telegram", externalId: ext, contactName: "Тест", contactHandle: handle }).returning())[0];

  // Посторонний: один отказ, модель не вызывается, на второе сообщение — тишина
  const stranger = await mk("555", "@stranger");
  await addMessage(stranger.id, "user", "Привет, сколько стоит?");
  await respond(stranger.id);
  await addMessage(stranger.id, "user", "Ау?");
  await respond(stranger.id);
  const strangerTg = tg.filter((x) => x.chat === "555");
  const callsAfterStranger = modelCalls;

  // Сотрудник: заявка на согласование
  const emp = await mk("444", "@Ivan_Petrov");
  call = { name: "request_approval", input: { subject: "Отпуск 3–7 ноября", details: "Иван, отпуск за свой счёт", amount: "" } };
  await addMessage(emp.id, "user", "Хочу отпуск с 3 по 7 ноября");
  await respond(emp.id);
  await new Promise((r) => setTimeout(r, 300));
  const [appr] = await db.select().from(approvals).where(eq(approvals.agentId, agent.id));
  const ownerMsg = tg.find((x) => x.chat === "777" && x.text.includes("Заявка №"));
  const studioGotIt = tg.some((x) => x.chat === "900" && x.text.includes("Заявка №"));

  const { decideApproval } = await import("@/lib/team/approvals");
  const decided = await decideApproval(appr.id, true, "Олег", "Хорошего отдыха");
  const again = await decideApproval(appr.id, false, "Олег");
  const empTg = tg.filter((x) => x.chat === "444").map((x) => x.text);
  const empMsgs = await db.select({ role: messages.role, text: messages.text }).from(messages).where(eq(messages.conversationId, emp.id));

  // Тестовый режим — заявка не создаётся
  const { prepareChat } = await import("@/lib/agent/runtime");
  const { streamChat } = await import("@/lib/llm");
  const p = await prepareChat(agentConfigSchema.parse((await db.select().from(agents).where(eq(agents.id, agent.id)))[0].config), (await db.select().from(clients).where(eq(clients.id, agent.clientId)))[0], [{ role: "user", content: "Отпуск" }], { mode: "dry", agentId: agent.id });
  for await (const e of streamChat({ model: "anthropic:claude-haiku-5-5", effort: "low", system: p.system, messages: p.messages, tools: p.tools })) void e;
  const all = await db.select().from(approvals).where(eq(approvals.agentId, agent.id));

  await db.delete(approvals).where(eq(approvals.agentId, agent.id));
  await db.delete(conversations).where(eq(conversations.channelId, ch.id));
  await db.delete(channels).where(eq(channels.id, ch.id));
  await db.delete(agents).where(eq(agents.id, agent.id));
  if (notify === undefined) await db.delete(settings).where(eq(settings.key, "notify"));
  else await setSetting("notify", notify);
  stub.close();

  const buttons = JSON.stringify(ownerMsg?.markup ?? {});
  const result: Record<string, boolean> = {
    "список доступа: ник, телефон, id, «*», чужие — нет": allow.every(Boolean),
    "посторонний: один отказ, без модели": strangerTg.length === 1 && strangerTg[0].text.includes("Только для сотрудников") && callsAfterStranger === 0,
    "сотрудник: подсказка для команды в инструкции": lastSystem.includes("помощник для сотрудников") && lastSystem.includes("request_approval"),
    "заявка сохранена с номером и автором": Boolean(appr) && appr.number >= 1 && appr.subject === "Отпуск 3–7 ноября" && appr.requester.includes("@Ivan_Petrov") && appr.status === "pending",
    "владельцу — заявка с кнопками, студии — нет (решают владельцы)": Boolean(ownerMsg) && buttons.includes(`ap:${appr?.id}`) && buttons.includes(`ax:${appr?.id}`) && !studioGotIt,
    "решение: статус, ответ сотруднику в чат, повторно — нельзя":
      decided?.status === "approved" && again === null && empTg.some((x) => x.includes("✅ Согласовано") && x.includes("Хорошего отдыха")) && empMsgs.some((m) => m.role === "assistant" && m.text.includes("Согласовано")),
    "тестовый режим — заявка не создаётся": all.length === 1 && Boolean(p.tools?.some((t) => t.name === "request_approval")),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
