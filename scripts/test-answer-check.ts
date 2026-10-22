/** Проверка ответа перед отправкой: ловит подмену вопроса и переписывает; хороший ответ — без изменений; выключено —
 *  без проверки; сбой проверки — уходит исходный ответ (модель — заглушка). DB_PATH=<копия caltest> npx tsx scripts/test-answer-check.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const agentReplies: string[] = [];
  let verdict: { ok: boolean; problems: string[] } | "fail" = { ok: true, problems: [] };
  let checks = 0;
  let rewriteAsked = "";
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      const sys = JSON.stringify(b.system ?? "");
      const isCheck = sys.includes("Ты проверяешь черновик ответа");
      const isAux = sys.includes("Заполни карточку") || /выжимк/i.test(sys);
      if (isCheck) {
        checks++;
        if (verdict === "fail") {
          res.writeHead(500);
          res.end("{}");
          return;
        }
      }
      const last = JSON.stringify(b.messages?.at(-1) ?? "");
      if (!isCheck && !isAux && last.includes("Служебная проверка")) rewriteAsked = last;
      const text = isCheck
        ? JSON.stringify(verdict)
        : isAux
          ? JSON.stringify({ temperature: "cold", reason: "", fields: [], test: false, summary: "", wants: "", discussed: "", expects: "", draft: "" })
          : (agentReplies.shift() ?? "Ответ");
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
  await new Promise<void>((r) => stub.listen(4038, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4038";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:9";

  const [agent] = await db.select().from(agents).limit(1);
  const cfg = agent.config;
  const key = "ga_check-test-key-0123456789";
  const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "api", name: "check-test", config: { key, label: "@check_bot" } }).returning();
  const route = await import("@/app/api/agent/[channelId]/route");
  const ask = (user: string, text: string) =>
    route
      .POST(
        new Request(`http://x/api/agent/${ch.id}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ user: { id: user, name: "Анатолий" }, text }),
        }),
        { params: Promise.resolve({ channelId: ch.id }) },
      )
      .then((r) => r.json());
  const setCheck = (on: boolean) => db.update(agents).set({ status: "active", config: { ...cfg, answerCheck: on } }).where(eq(agents.id, agent.id));

  // 1) Подмена вопроса — проверка ловит, ответ переписан
  await setCheck(true);
  verdict = { ok: false, problems: ["Клиент спросил цену вторички, а черновик про налог ITP — подмена вопроса"] };
  agentReplies.push("Для вторички до 1 000 000 € ITP составляет 9%.", "Вторичного жилья в нашей базе нет, цен на него у меня нет — уточню у менеджера.");
  const r1 = await ask("check-1", "Сколько стоит вторичка до 1 млн?");
  const conv1 = (await db.select().from(conversations).where(eq(conversations.channelId, ch.id)))[0];
  const saved1 = (await db.select().from(messages).where(eq(messages.conversationId, conv1.id))).find((m) => m.role === "assistant");

  // 2) Хороший ответ — без переписывания
  verdict = { ok: true, problems: [] };
  agentReplies.push("Виллы Sierra Verde: в продаже №1, №3 и №5.");
  const before2 = checks;
  const r2 = await ask("check-2", "Какие виллы в Sierra Verde?");
  const after2 = checks;

  // 3) Выключено — проверки нет
  await setCheck(false);
  agentReplies.push("Ответ без проверки.");
  const before3 = checks;
  const r3 = await ask("check-3", "Привет");
  const after3 = checks;

  // 4) Сбой проверки — уходит исходный ответ
  await setCheck(true);
  verdict = "fail";
  agentReplies.push("Исходный ответ при сбое проверки: 5 вилл.");
  const before4 = checks;
  const r4 = await ask("check-4", "Вопрос");
  const after4 = checks;

  // 5) Простой ответ (коротко, без цифр и названий) — без проверки
  verdict = { ok: false, problems: ["не должно вызываться"] };
  agentReplies.push("Здравствуйте! Чем могу помочь?");
  const before5 = checks;
  const r5 = await ask("check-5", "Привет");
  const after5 = checks;

  for (const c of await db.select().from(conversations).where(eq(conversations.channelId, ch.id))) {
    await db.delete(messages).where(eq(messages.conversationId, c.id));
    await db.delete(conversations).where(eq(conversations.id, c.id));
  }
  await db.delete(channels).where(eq(channels.id, ch.id));
  await db.update(agents).set({ config: cfg, status: agent.status }).where(eq(agents.id, agent.id));
  stub.close();

  const result: Record<string, boolean> = {
    "подмена — клиент получил исправленный ответ": typeof r1.reply === "string" && r1.reply.includes("Вторичного жилья") && !r1.reply.includes("ITP"),
    "агенту переданы замечания проверки": rewriteAsked.includes("подмена вопроса"),
    "в сообщении — отметка «исправлен проверкой»": Boolean(saved1?.meta?.check?.rewritten) && saved1!.text.includes("Вторичного жилья"),
    "хороший ответ — без изменений, одна проверка": r2.reply === "Виллы Sierra Verde: в продаже №1, №3 и №5." && after2 === before2 + 1,
    "выключено — проверки нет": r3.reply === "Ответ без проверки." && after3 === before3,
    "сбой проверки — уходит исходный ответ": r4.reply === "Исходный ответ при сбое проверки: 5 вилл." && after4 > before4,
    "простой ответ — без проверки": r5.reply === "Здравствуйте! Чем могу помочь?" && after5 === before5,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
