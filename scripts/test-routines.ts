/** Отчёты по расписанию: «пора ли» по Киеву (день, неделя, месяц, не дважды в день), сбор данных (разговоры,
 *  Google Таблица, страница сайта, поиск выключен — пометка), задание модели, отправка сотрудникам и владельцу.
 *  Модель, Google и Telegram — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-routines.ts */
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, routines, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  let prompt = "";
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (o: object) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url?.startsWith("/bot")) {
        if (req.url.endsWith("/sendMessage")) tg.push({ chat: String(JSON.parse(body).chat_id), text: JSON.parse(body).text });
        return json({ ok: true, result: req.url.endsWith("/getUpdates") ? [] : { message_id: 1 } });
      }
      if (req.url === "/token") return json({ access_token: "t", expires_in: 3600 });
      if (req.url?.startsWith("/v4/")) return json({ values: [["Статья", "План", "Факт"], ["Реклама", "1000", "1450"]] });
      if (req.url === "/competitor") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<html><head><title>Конкурент</title></head><body><main><h1>Акция</h1><p>Скидка 15% на виллы до конца месяца у конкурента. Новые объекты в Альтеа.</p>" + "<p>Компания строит виллы и апартаменты на побережье, предлагает рассрочку от застройщика, бесплатный трансфер на просмотр и юридическое сопровождение сделки. Цены на апартаменты начинаются от 180 000 евро, на виллы — от 650 000 евро. Сдача первой очереди запланирована на весну следующего года.</p>".repeat(3) + "</main></body></html>");
      }
      prompt = body;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = "## Главное\nРеклама превысила план на 45%.\n- **Заявок**: 1\n- Конкурент даёт скидку 15%";
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
  await new Promise<void>((r) => stub.listen(4055, r));
  const B = "http://127.0.0.1:4055";
  Object.assign(process.env, { ANTHROPIC_BASE_URL: B, ANTHROPIC_API_KEY: "stub", TELEGRAM_API_URL: B, GOOGLE_TOKEN_URL: `${B}/token`, GOOGLE_SHEETS_URL: `${B}/v4/spreadsheets`, TOOLS_ALLOW_PRIVATE_FOR_TESTS: "1" });

  const before = { notify: await getSetting("notify"), google: await getSetting("google"), services: await getSetting("services") };
  const [agent] = await db.select().from(agents).limit(1);
  await setSetting("notify", { token: "stub", subscribers: [{ chatId: "100" }], owners: [{ chatId: "200", name: "Олег", since: 0, clientId: agent.clientId }] });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await setSetting("google", { clientEmail: "sa@test.iam", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  await setSetting("services", { webSearch: { enabled: false, maxUses: 3 } });
  const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id)).limit(1);
  const [conv] = await db.insert(conversations).values({ clientId: agent.clientId, agentId: agent.id, channelId: ch.id, channelType: ch.type, externalId: "rt-1", contactName: "Мария" }).returning();
  await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Хочу виллу у моря до 600 тысяч" });

  const [r] = await db
    .insert(routines)
    .values({
      clientId: agent.clientId,
      name: "Итоги недели",
      task: "Сравни план и факт, посмотри конкурента, посчитай заявки",
      schedule: { freq: "weekly", hour: 9, weekday: 1 },
      sources: [
        { type: "conversations", days: 7 },
        { type: "sheet", url: "https://docs.google.com/spreadsheets/d/BUDGETBUDGETBUDGETBUDGET/edit", sheet: "Бюджет" },
        { type: "url", url: `${B}/competitor` },
        { type: "search", query: "курс евро" },
      ],
      delivery: { team: true, owners: true },
      enabled: true,
    })
    .returning();

  const eng = await import("@/lib/routines/engine");
  // Понедельник 26.10.2026 09:30 по Киеву = 06:30 UTC; воскресенье — нет; до 9:00 — нет
  const mon930 = new Date("2026-10-26T07:30:00Z");
  const due = {
    weeklyMon: eng.isDue({ freq: "weekly", hour: 9, weekday: 1 }, null, mon930),
    weeklySun: !eng.isDue({ freq: "weekly", hour: 9, weekday: 1 }, null, new Date("2026-10-25T07:30:00Z")),
    tooEarly: !eng.isDue({ freq: "daily", hour: 10 }, null, mon930),
    alreadyToday: !eng.isDue({ freq: "daily", hour: 9 }, new Date("2026-10-26T07:05:00Z"), mon930),
    monthlyLastDay: eng.isDue({ freq: "monthly", hour: 9, day: 31 }, null, new Date("2026-11-30T08:00:00Z")),
  };
  const out = await eng.runRoutine(r.id);
  const [saved] = await db.select().from(routines).where(eq(routines.id, r.id));

  await db.delete(routines).where(eq(routines.id, r.id));
  await db.delete(messages).where(eq(messages.conversationId, conv.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) await db.delete(settings).where(eq(settings.key, k));
    else await setSetting(k, v);
  }
  stub.close();

  const p = JSON.parse(prompt || "{}");
  const userMsg = JSON.stringify(p.messages ?? []);
  const result: Record<string, boolean> = {
    "расписание по Киеву": Object.values(due).every(Boolean),
    "данные: разговоры, таблица, страница": userMsg.includes("Хочу виллу у моря") && userMsg.includes("Реклама | 1000 | 1450") && userMsg.includes("Скидка 15%"),
    "поиск выключен — пометка модели": JSON.stringify(p.system ?? "").includes("Поиск в интернете сейчас выключен") && !JSON.stringify(p.tools ?? []).includes("web_search"),
    "отчёт сотрудникам и владельцу": tg.some((x) => x.chat === "100") && tg.some((x) => x.chat === "200"),
    "оформление для Telegram": tg[0]?.text.includes("📊 <b>Итоги недели</b>") && tg[0]?.text.includes("<b>Главное</b>") && tg[0]?.text.includes("• <b>Заявок</b>: 1"),
    "итог сохранён": out.ok && saved.lastStatus === "ok" && Boolean(saved.lastResult?.includes("45%")),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
