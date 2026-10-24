/** Владелец клиента в боте уведомлений: подписка по ссылке, вопросы без ответа, ответ → база знаний, только свои вопросы
 *  (Telegram — заглушка, без ИИ). DB_PATH=<копия caltest> npx tsx scripts/test-owners.ts */
import http from "node:http";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, conversations, kbSources, knowledgeGaps, messages, settings } from "@/db/schema";
import { ANSWERS_TITLE } from "@/lib/agent/kb-answers";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const out: { chat: string; text: string; markup?: string }[] = [];
  const answers: string[] = [];
  let mid = 100;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = body ? JSON.parse(body) : {};
      if (String(req.url).endsWith("/sendMessage")) out.push({ chat: String(b.chat_id), text: String(b.text), markup: JSON.stringify(b.reply_markup ?? {}) });
      if (String(req.url).endsWith("/answerCallbackQuery")) answers.push(String(b.text));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: ++mid } }));
    });
  });
  await new Promise<void>((r) => server.listen(4029, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4029";

  const [oldNotify] = await db.select().from(settings).where(eq(settings.key, "notify"));
  const value = { token: "123:TEST", botUsername: "test_notify_bot", linkCode: "studio", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "Студия", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value } });
  const kbBefore = await db.select().from(kbSources);
  const n = await import("@/lib/notify/telegram");

  // Два клиента, у каждого вопрос без ответа
  const all = await db.select().from(agents);
  const a1 = all[0];
  const a2 = all.find((a) => a.clientId !== a1.clientId)!;
  const [g1] = await db.insert(knowledgeGaps).values({ agentId: a1.id, clientId: a1.clientId, question: "Есть ли парковка у офиса?", count: 3, examples: [] }).returning();
  const [g0] = await db.insert(knowledgeGaps).values({ agentId: a1.id, clientId: a1.clientId, question: "Работаете ли в праздники?", count: 1, examples: [], suggestion: "В праздники — по записи." }).returning();
  const [g2] = await db.insert(knowledgeGaps).values({ agentId: a2.id, clientId: a2.clientId, question: "Чужой вопрос", count: 1, examples: [] }).returning();

  const link = await n.ownerLink(a1.clientId);
  const code = link?.split("start=")[1] ?? "";
  const owner = { id: 900, type: "private" };
  const msg = (text: string, extra: object = {}) => n.handleNotifyUpdate({ update_id: mid++, message: { message_id: mid++, chat: owner, from: { first_name: "Олег" }, text, ...extra } } as never);
  const press = (data: string) => n.handleNotifyUpdate({ update_id: mid++, callback_query: { id: "cb", from: { first_name: "Олег" }, data, message: { chat: owner, message_id: 5, text: "x" } } } as never);

  // 1) Подписка по ссылке клиента — сразу приходят вопросы (свои, самые частые первыми)
  await msg(`/start ${code}`);
  const toOwner = out.filter((m) => m.chat === "900");
  const s1 = await n.getNotifySettings();

  // 2) Ответ на свой вопрос → база знаний, студия видит, кто ответил
  out.length = 0;
  await press(`ga:${g1.id}`);
  const prompt = out.find((m) => m.chat === "900")?.text ?? "";
  await msg("Да, бесплатная парковка во дворе.");
  const [g1after] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, g1.id));
  const thanks = out.some((m) => m.chat === "900" && m.text.includes("Ответ добавлен"));
  const studioSaw = out.some((m) => m.chat === "777" && m.text.includes("Владелец ответил") && m.text.includes("бесплатная парковка"));
  const [kb] = await db.select().from(kbSources).where(and(eq(kbSources.clientId, a1.clientId), eq(kbSources.title, ANSWERS_TITLE)));

  // 3) Готовый ответ сотрудника — сохранить одной кнопкой
  await press(`kb:${g0.id}`);
  const [g0after] = await db.select().from(knowledgeGaps).where(eq(knowledgeGaps.id, g0.id));

  // 4) Чужое недоступно: вопрос другого клиента, ответ клиенту, черновик
  answers.length = 0;
  await press(`ga:${g2.id}`);
  // Разговор другого клиента: в разговорах своего клиента владелец может отвечать и решать передачи
  const [conv] = await db.select().from(conversations).where(eq(conversations.clientId, a2.clientId)).limit(1);
  await press(`rp:${conv.id}`);
  await press(`ap:${conv.id}`);
  // ap: — теперь кнопка согласования заявки: чужой id — «Заявка не найдена», тоже без доступа
  const denied = answers.length === 3 && answers.every((a) => a === "Нет доступа" || a === "Заявка не найдена");

  // 5) Рассылки студии владельцу не уходят; просто текст — подсказка, а не ответ клиенту
  out.length = 0;
  await n.notifyHandoff(conv.id, "Выжимка");
  const studioOnly = out.length > 0 && out.every((m) => m.chat === "777");
  out.length = 0;
  await msg("Привет");
  const hint = out.find((m) => m.chat === "900")?.text ?? "";

  // 6) Отписка
  await msg("/stop");
  const s6 = await n.getNotifySettings();

  // Убрать за собой
  await db.delete(knowledgeGaps).where(inArray(knowledgeGaps.id, [g1.id, g0.id, g2.id]));
  const keepIds = kbBefore.map((k) => k.id);
  await db.delete(kbSources).where(keepIds.length ? notInArray(kbSources.id, keepIds) : undefined);
  for (const k of kbBefore) await db.update(kbSources).set({ content: k.content, chars: k.chars, chunks: k.chunks }).where(eq(kbSources.id, k.id));
  await db.delete(messages).where(eq(messages.text, "__never__"));
  if (oldNotify) await db.update(settings).set({ value: oldNotify.value }).where(eq(settings.key, "notify"));
  else await db.delete(settings).where(eq(settings.key, "notify"));
  server.close();

  const checks: Record<string, boolean> = {
    "ссылка владельца — своя для клиента": Boolean(link?.includes("start=c_")),
    "подписка: владелец записан к своему клиенту, не в сотрудники": (s1?.owners ?? []).some((o) => o.chatId === "900" && o.clientId === a1.clientId) && !s1?.subscribers.some((x) => x.chatId === "900"),
    "сразу пришли свои вопросы, частый — первым, чужого нет": toOwner.length >= 4 && toOwner.findIndex((m) => m.text.includes("парковка")) < toOwner.findIndex((m) => m.text.includes("праздники")) && toOwner.some((m) => m.markup?.includes(`ga:${g1.id}`)) && !toOwner.some((m) => m.text.includes("Чужой вопрос")),
    "у вопроса с готовым ответом — кнопка «Сохранить»": toOwner.some((m) => m.markup?.includes(`kb:${g0.id}`)),
    "ответ владельца → база знаний, вопрос закрыт": prompt.includes("парковка") && g1after.status === "resolved" && Boolean(kb?.content.includes("бесплатная парковка")) && thanks,
    "студия видит ответ владельца": studioSaw,
    "готовый ответ сохранён кнопкой": g0after.status === "resolved",
    "чужой вопрос, ответ клиенту и черновики — нет доступа": denied,
    "рассылки студии владельцу не приходят": studioOnly,
    "текст без кнопки — подсказка": hint.includes("✍️ Ответить"),
    "отписка": !(s6?.owners ?? []).some((o) => o.chatId === "900"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
