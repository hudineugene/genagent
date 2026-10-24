/** Контроль сервисов (проверка сайта, сигнал из системы, инцидент, черновик клиентам → рассылка, восстановление) и
 *  обучение в чате (личная программа, урок, тест проверяет код, баллы за урок и курс, напоминание продолжить).
 *  Модель, сайт и Telegram — макеты.  DB_PATH=<копия caltest> npx tsx scripts/test-monitor-learning.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, campaigns, channels, clients, conversations, courses, incidents, learners, lessons, loyaltyAccounts, loyaltyPrograms, monitors } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  let siteUp = true;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        const b = JSON.parse(body || "{}");
        if (req.url.endsWith("/sendMessage")) tg.push({ chat: String(b.chat_id), text: b.text });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      if (req.url?.startsWith("/site")) {
        res.writeHead(siteUp ? 200 : 503, { "content-type": "text/html" });
        return res.end(siteUp ? "<html>Оплата работает</html>" : "Service Unavailable");
      }
      const b = JSON.parse(body);
      const sys = typeof b.system === "string" ? b.system : JSON.stringify(b.system);
      const text = sys.includes("упреждающее")
        ? JSON.stringify({ draft: "Сейчас не проходит онлайн-оплата. Мы уже чиним — заказ можно оплатить при получении.", resolved: "Онлайн-оплата снова работает." })
        : JSON.stringify({ quiz: [{ q: "Сколько дней на возврат?", options: ["7", "14", "30"], correct: 1 }] });
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
  await new Promise<void>((r) => stub.listen(4072, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4072";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4072";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Monitor Learning Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "ml-agent" }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "123:t" } as never }).returning();
  const [conv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "telegram", externalId: "901", contactName: "Оля", contactHandle: "@olya" }).returning();

  // ---------- контроль сервисов ----------
  const { runMonitor, signal, draftToCampaign, checkUrl, newMonitorKey } = await import("@/lib/monitor");
  const [m] = await db.insert(monitors).values({ clientId: c.id, name: "Онлайн-оплата", url: "http://127.0.0.1:4072/site", expectText: "Оплата работает", failThreshold: 2, apiKey: newMonitorKey(), audience: "все, кто оплачивает онлайн" }).returning();
  const okCheck = await checkUrl(m);
  const slow = await checkUrl({ ...m, maxMs: 0 });
  const missing = await checkUrl({ ...m, expectText: "Корзина" });
  siteUp = false;
  const load = async () => (await db.select().from(monitors).where(eq(monitors.id, m.id)))[0];
  await runMonitor(await load());
  const afterOne = await load();
  await runMonitor(await load());
  const afterTwo = await load();
  const [inc] = await db.select().from(incidents).where(eq(incidents.monitorId, m.id));
  const alert = tg.find((x) => x.text.includes("Сбой: Онлайн-оплата"));
  const camp = await draftToCampaign(inc.id, inc.draft, 7, "draft");
  const [campRow] = await db.select().from(campaigns).where(eq(campaigns.id, camp!.id));
  await runMonitor(await load());
  const noDuplicate = (await db.select().from(incidents).where(eq(incidents.monitorId, m.id))).length === 1;
  siteUp = true;
  await runMonitor(await load());
  const [incAfter] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  const upMsg = tg.find((x) => x.text.includes("Снова работает: Онлайн-оплата"));
  // Сигнал из системы клиента: ошибок больше порога — сразу инцидент
  const [hook] = await db.insert(monitors).values({ clientId: c.id, name: "Приложение", kind: "webhook", apiKey: newMonitorKey() }).returning();
  const sig = await signal(hook, { errors: 37, threshold: 10 });
  const [hookAfter] = await db.select().from(monitors).where(eq(monitors.id, hook.id));

  // ---------- обучение ----------
  const { learningTools, buildPath, generateQuiz, learningTick } = await import("@/lib/learning");
  const [prog] = await db.insert(loyaltyPrograms).values({ clientId: c.id, name: "Знания", unit: "баллов", apiKey: "lp_x", rewards: [{ name: "Скидка 10%", cost: 50 }] }).returning();
  const [c1] = await db.insert(courses).values({ clientId: c.id, title: "Основы продаж", level: "beginner", topics: "продажи, клиенты", points: 30, programId: prog.id, position: 0 }).returning();
  const [c2] = await db.insert(courses).values({ clientId: c.id, title: "Сложные переговоры", level: "advanced", topics: "переговоры", points: 50, programId: prog.id, position: 1 }).returning();
  const [c3] = await db.insert(courses).values({ clientId: c.id, title: "Бухгалтерия", level: "beginner", topics: "налоги, отчёты", position: 2 }).returning();
  const [l1] = await db.insert(lessons).values({ courseId: c1.id, position: 0, title: "Возврат товара", body: "Возврат — 14 дней.", videoUrl: "https://video.example/1", quiz: [{ q: "Сколько дней на возврат?", options: ["7", "14"], correct: 1 }], points: 10 }).returning();
  const [l2] = await db.insert(lessons).values({ courseId: c1.id, position: 1, title: "Работа с возражениями", body: "Слушайте и уточняйте.", quiz: [], points: 10 }).returning();
  await db.insert(lessons).values({ courseId: c2.id, position: 0, title: "Тактики", body: "…" });
  await db.insert(lessons).values({ courseId: c3.id, position: 0, title: "НДС", body: "…" });
  const tools = learningTools({ mode: "live", clientId: c.id, conversationId: conv.id, agentId: a.id });
  const plan = await tools[0].run({ goal: "хочу лучше продавать клиентам", level: "beginner" });
  const next = await tools[1].run({});
  const wrong = await tools[2].run({ lesson_id: l1.id, answers: [1] });
  const right = await tools[2].run({ lesson_id: l1.id, answers: [2] });
  const done2 = await tools[2].run({ lesson_id: l2.id, answers: [] });
  const progress = await tools[3].run({});
  const { learningStats } = await import("@/lib/learning");
  const lstats = await learningStats(c.id);
  const [learner] = await db.select().from(learners).where(eq(learners.clientId, c.id));
  const [acc] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.programId, prog.id));
  const advPath = buildPath(
    [
      { course: c1, lessons: [l1] },
      { course: c2, lessons: [] },
    ],
    { results: {} },
    "переговоры",
    "advanced",
  );
  const quiz = await generateQuiz(c.id, "Возврат — 14 дней.");
  // Молчит 4 дня — напоминание продолжить (в Сложные переговоры)
  await db.update(learners).set({ lastActivityAt: new Date(Date.now() - 4 * 86400_000), path: [c1.id, c2.id] }).where(eq(learners.id, learner.id));
  const tgBefore = tg.length;
  const reminded = await learningTick(new Date("2026-10-26T09:00:00Z"));
  const remindText = tg.slice(tgBefore).find((x) => x.chat === "901")?.text ?? "";
  const remindedAgain = await learningTick(new Date("2026-10-26T09:10:00Z"));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const result: Record<string, boolean> = {
    "проверка: ответ, нужный текст, скорость": okCheck.ok && !slow.ok && slow.error.includes("медленно") && !missing.ok && missing.error.includes("Корзина"),
    "один сбой — ещё не инцидент, второй — инцидент и команде": afterOne.status !== "down" && afterTwo.status === "down" && Boolean(inc) && Boolean(alert?.text.includes("оплатить при получении")),
    "черновик клиентам → выключенная рассылка тем, кто писал за 7 дней": campRow.status === "draft" && !campRow.enabled && campRow.segment.activeWithinDays === 7 && campRow.steps[0].text.includes("чиним"),
    "пока лежит — повторных инцидентов нет; поднялся — закрыт, команде": noDuplicate && incAfter.status === "resolved" && Boolean(upMsg) && incAfter.resolvedDraft.includes("снова работает"),
    "сигнал из системы: ошибок больше порога — сразу инцидент": Boolean(sig.incident) && hookAfter.status === "down",
    "личная программа: под цель и уровень, без лишнего": plan.includes("Основы продаж") && !plan.includes("Бухгалтерия") && advPath.join() === c2.id,
    "урок: текст, видео, тест без ответов": next.includes("Возврат — 14 дней") && next.includes("video.example") && next.includes("1) 7") && !next.includes("correct"),
    "тест проверяет код: неверно — без ответа, верно — баллы": wrong.includes("not passed") && !wrong.includes("correct:") && right.includes("passed") && right.includes("Points earned: 10"),
    "курс пройден: бонус курса, баллы в программу клиента": done2.includes("Points earned: 40") && done2.includes("completed") && learner.points === 50 && acc?.balance === 50,
    "прогресс и на что потратить баллы": progress.includes("Основы продаж: 2/2") && progress.includes("Скидка 10%"),
    "тест к уроку из текста (ИИ)": quiz.length === 1 && quiz[0].correct === 1,
    "аналитика: начали, закончили, средний балл, где застревают": lstats.learners === 1 && lstats.courses[0].started === 1 && lstats.courses[0].finished === 1 && lstats.courses[0].avgScore === 100 && lstats.courses[0].hardest?.title === "Возврат товара",
    "напоминание продолжить — раз в 3 дня": reminded === 1 && remindText.includes("Тактики") && remindedAgain === 0,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
