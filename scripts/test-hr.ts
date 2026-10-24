/** Команда и документы: адаптация новичка (чек-лист с пунктами под должность, приветствие, утро, отметки через
 *  агента), отбор резюме по требованиям, благодарности коллегам баллами (лимит в месяц), итоги встречи участникам
 *  на почту, архив документов (тип, единое имя, папка). Модель, Telegram и почта — макеты.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-hr.ts */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, candidates, channels, clientDocTypes, clientDocuments, clients, conversations, loyaltyAccounts, loyaltyPrograms, meetings, onboardingPlans, onboardings, vacancies } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const reply = (sys: string, user: string) => {
    if (sys.includes("HR-помощник"))
      return { extra: [{ title: "Получить доступ к Figma", day: 1, kind: "task" }], welcome: "Мария, добро пожаловать! В первый день — знакомство с командой." };
    if (sys.includes("Ты рекрутер")) {
      const strong = user.includes("React 6 лет");
      return { name: strong ? "Олег" : "Ира", contact: strong ? "oleg@x.example" : "", score: strong ? 88 : 30, verdict: strong ? "strong" : "no", summary: strong ? "Опыт React 6 лет" : "Нет React", strengths: strong ? ["React 6 лет"] : [], gaps: strong ? [] : ["Нет React"] };
    }
    if (sys.includes("Определи, к какому из типов")) return { type: "t0", fields: [{ key: "supplier", value: "ТОВ Альфа" }, { key: "number", value: "INV-7" }, { key: "date", value: "2026-10-20" }], summary: "Счёт от ТОВ Альфа" };
    return {};
  };
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
      const b = JSON.parse(body);
      const sys = typeof b.system === "string" ? b.system : JSON.stringify(b.system);
      const text = JSON.stringify(reply(sys, String(b.messages[0].content)));
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
  await new Promise<void>((r) => stub.listen(4070, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4070";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4070";
  process.env.EMAIL_TEST_JSON = "1";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "HR Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "hr-agent" }).returning();
  const [tgCh] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "123:t" } as never }).returning();
  const [mail] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "email", name: "hr@test.local", config: { address: "hr@test.local", password: "x", imapHost: "x", imapPort: 993, smtpHost: "x", smtpPort: 465, fromName: "HR" } as never, enabled: false }).returning();
  const [maria] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tgCh.id, channelType: "telegram", externalId: "601", contactName: "Мария", contactHandle: "@maria_d" }).returning();
  const [kolya] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tgCh.id, channelType: "telegram", externalId: "602", contactName: "Коля Петров", contactHandle: "@kolya" }).returning();
  const { testOutbox } = await import("@/lib/channels/email-send");

  // 1. Адаптация
  const { createOnboarding, onboardingTick, onboardingTools } = await import("@/lib/onboarding");
  const [plan] = await db
    .insert(onboardingPlans)
    .values({ clientId: c.id, name: "Дизайнер", steps: [{ title: "Знакомство с командой", day: 0, kind: "meet", owner: "Анна (руководитель)" }, { title: "Прочитать гайд бренда", day: 0, kind: "read", owner: "" }, { title: "Первый макет", day: 3, kind: "task", owner: "" }], welcome: "Тепло, на ты" })
    .returning();
  const ob = await createOnboarding(c.id, { planId: plan.id, name: "Мария", role: "UI-дизайнер", contact: "@maria_d", email: "", channelId: null, startDate: "2026-11-02", notes: "", personalize: true });
  const welcome = tg.find((x) => x.chat === "601" && x.text.includes("добро пожаловать"));
  const tgBefore = tg.length;
  await onboardingTick(new Date("2026-11-02T07:00:00Z")); // 9:00 Киев
  const morning = tg.slice(tgBefore).find((x) => x.chat === "601");
  const teamMeet = tg.slice(tgBefore).find((x) => x.text.includes("Сегодня знакомства") && x.text.includes("Анна (руководитель)"));
  const tgAfterFirst = tg.length;
  await onboardingTick(new Date("2026-11-02T10:00:00Z"));
  const once = tg.length === tgAfterFirst;
  const tools = onboardingTools({ mode: "live", clientId: c.id, conversationId: maria.id, agentId: a.id });
  const list = await tools[0].run({});
  const firstId = ob.items[0].id;
  const marked = await tools[1].run({ item_id: firstId });
  const [obAfter] = await db.select().from(onboardings).where(eq(onboardings.id, ob.id));
  const stranger = await onboardingTools({ mode: "live", clientId: c.id, conversationId: kolya.id })[0].run({});

  // 2. Отбор резюме
  const { addCandidates, scoreCandidates } = await import("@/lib/hiring");
  const [vac] = await db.insert(vacancies).values({ clientId: c.id, title: "Frontend", requirements: "React от 3 лет (обязательно), TypeScript" }).returning();
  await addCandidates(vac.id, [
    { filename: "oleg.pdf", text: "Олег. React 6 лет, TypeScript. oleg@x.example" },
    { filename: "ira.docx", text: "Ира. Бухгалтер 5 лет." },
  ]);
  const ids = (await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.vacancyId, vac.id))).map((x) => x.id);
  await scoreCandidates(c.id, ids);
  const cands = await db.select().from(candidates).where(eq(candidates.vacancyId, vac.id));
  const oleg = cands.find((x) => x.filename === "oleg.pdf");
  const ira = cands.find((x) => x.filename === "ira.docx");

  // 3. Благодарности коллегам
  const { loyaltyTools, givePoints, peerStats } = await import("@/lib/loyalty/engine");
  const [prog] = await db.insert(loyaltyPrograms).values({ clientId: c.id, name: "Спасибо", unit: "баллов", apiKey: "lp_test", peerAllowance: 100, rewards: [{ name: "Худи", cost: 150 }] }).returning();
  const lt = loyaltyTools(prog, { mode: "live", clientId: c.id, conversationId: maria.id, agentId: a.id });
  const give = lt.find((x) => x.name === "loyalty_thank_colleague")!;
  const g1 = await give.run({ colleague: "@kolya", points: 60, reason: "помог с макетом" });
  const g2 = await give.run({ colleague: "@kolya", points: 50, reason: "ещё" });
  const [mAcc] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.contact, "maria_d"));
  const self = await givePoints(prog, mAcc, "@maria_d", 5, "");
  const [kAcc] = await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.contact, "kolya"));
  const thanked = tg.find((x) => x.chat === "602" && x.text.includes("благодарит"));
  const stats = await peerStats(prog.id);
  const noPeer = loyaltyTools({ ...prog, peerAllowance: 0 }, { mode: "live", clientId: c.id }).some((x) => x.name === "loyalty_thank_colleague");

  // 4. Итоги встречи участникам на почту
  const { emailParticipants, meetingEmail } = await import("@/lib/meetings/engine");
  const [m] = await db
    .insert(meetings)
    .values({ clientId: c.id, title: "Планёрка", summary: "Обсудили запуск", result: "## Решения\n**Запуск** 1 ноября", tasks: [{ who: "Коля", what: "Подготовить лендинг", due: "30.10" }], status: "done", delivery: { team: false, owners: false, emails: ["a@x.example", "B@x.example", "плохой"], channelId: mail.id } })
    .returning();
  const mailStatus = await emailParticipants(m);
  const meetMail = testOutbox.find((x) => x.subject === "Итоги встречи: Планёрка");
  const body = meetingEmail(m);

  // 5. Архив документов
  const { archiveFiles, DOCS_DIR } = await import("@/lib/documents/archive");
  const { documentTitle } = await import("@/lib/documents/intake");
  await db.insert(clientDocTypes).values({ clientId: c.id, name: "Счёт", purpose: "Счёт на оплату", fields: [{ key: "supplier", label: "Поставщик" }, { key: "number", label: "Номер" }, { key: "date", label: "Дата" }], folder: "Бухгалтерия/Счета", nameTemplate: "{{date}} Счёт {{supplier}} {{number}}" });
  const saved = await archiveFiles(c.id, [{ buf: Buffer.from("Счёт INV-7 от ТОВ Альфа, 20.10.2026, сумма 500 €"), filename: "scan 01.txt" }]);
  const [doc] = await db.select().from(clientDocuments).where(eq(clientDocuments.clientId, c.id));
  const fileOk = Boolean(doc?.file) && fs.existsSync(path.join(DOCS_DIR, doc.file));
  const otherTitle = documentTitle(null, {}, "Отчёт: Q3/итоги.pdf", "2026-10-24");
  if (doc?.file) fs.rmSync(path.join(DOCS_DIR, doc.file), { force: true });

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const result: Record<string, boolean> = {
    "адаптация: чек-лист из плана + пункт под должность, даты от выхода": ob.items.length === 4 && ob.items.some((i) => i.title === "Получить доступ к Figma" && i.due === "2026-11-03") && ob.items.some((i) => i.title === "Первый макет" && i.due === "2026-11-05"),
    "приветствие ушло новичку в чат": Boolean(welcome) && ob.welcomeText.includes("добро пожаловать"),
    "утро: новичку — план на сегодня, команде — знакомства; раз в день": morning?.text.includes("Знакомство с командой") === true && Boolean(teamMeet) && once,
    "агент команды: чек-лист и отметка «сделано»; чужому — нет плана": list.includes("Знакомство с командой") && marked.includes("Items left: 3") && obAfter.items.find((i) => i.id === firstId)?.done === true && stranger.includes("no onboarding"),
    "резюме: балл, вывод, обоснование, имя из резюме": oleg?.score === 88 && oleg.verdict === "strong" && oleg.name === "Олег" && oleg.strengths[0] === "React 6 лет" && ira?.verdict === "no" && ira.gaps[0] === "Нет React",
    "благодарность: коллега получил баллы, лимит в месяц, себе — нельзя": g1.includes("got 60") && g2.includes("give 40 more") && kAcc?.balance === 60 && "error" in self && self.error === "self" && Boolean(thanked),
    "лента благодарностей и выключенный режим": stats.top[0]?.points === 60 && stats.recent[0]?.reason.includes("помог с макетом") === true && !noPeer,
    "итоги встречи участникам: только верные адреса, задачи и решения": mailStatus === "sent" && meetMail?.from === "hr@test.local" && String(meetMail.to) === "a@x.example,b@x.example" && body.includes("Коля: Подготовить лендинг — до 30.10") && body.includes("Запуск 1 ноября") && !body.includes("**"),
    "архив: тип, единое имя по шаблону, папка, файл сохранён": saved.length === 1 && doc?.title === "2026-10-20 Счёт ТОВ Альфа INV-7.txt" && doc.folder === "Бухгалтерия/Счета" && fileOk,
    "имя без недопустимых символов": otherTitle === "2026-10-24 Отчёт Q3 итоги.pdf",
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
