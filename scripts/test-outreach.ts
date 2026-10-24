/** Письма по спискам: столбцы узнаются по названиям, исследование компании (поиск), письмо по заданию группы,
 *  одобрение и отправка днём с почты клиента (разговор создаётся, ответ попадёт агенту), «стоп» отписывает,
 *  режим «в существующие чаты» находит разговор по @нику. Модель, Telegram и почта — макеты.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-outreach.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, contacts, conversations, messages, outreach, outreachMessages, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const prompts: string[] = [];
  let searches = 0;
  const tg: { chat: string; text: string }[] = [];
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
      const b = JSON.parse(body);
      let text: string;
      if (b.tools?.some((t: { type?: string }) => String(t.type ?? "").startsWith("web_search"))) {
        searches++;
        text = "Компания открыла офис в Валенсии в сентябре (valencia.example).";
      } else {
        prompts.push(`${typeof b.system === "string" ? b.system : JSON.stringify(b.system)}\n${b.messages[0].content}`);
        const who = /Контакт: ([^,\n]+)/.exec(b.messages[0].content)?.[1] ?? "друг";
        text = JSON.stringify({ subject: `Для ${who}`, body: `Здравствуйте, ${who}! Письмо по делу.` });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4065, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4065";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4065";
  process.env.EMAIL_TEST_JSON = "1";
  const services = await getSetting("services");
  await setSetting("services", { webSearch: { enabled: true, maxUses: 3 } });

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Outreach Test", description: "Строим апартаменты" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "outreach-agent" }).returning();
  const [mail] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "email", name: "sales@test.local", config: { address: "sales@test.local", password: "x", imapHost: "x", imapPort: 993, smtpHost: "x", smtpPort: 465, fromName: "Test Sales" } as never, enabled: false }).returning();
  const [tgCh] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "123:t" } as never }).returning();
  const [tgConv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tgCh.id, channelType: "telegram", externalId: "777", contactName: "Олег", contactHandle: "@oleg_k" }).returning();

  const { importContacts, generateOutreach, sendOutreachTick } = await import("@/lib/outreach/engine");
  const { list, count } = await importContacts(c.id, "Вебинар", ["ФИО", "E-mail", "Компания", "Сайт", "Активность", "Должность", "Telegram"], [
    ["Анна Иванова", "Anna@Corp.example", "Corp", "corp.example", "активный", "директор", ""],
    ["Борис", "boris@x.example", "", "", "пассивный", "", ""],
    ["Без контактов", "", "Z", "", "", "", ""],
    ["Олег", "", "", "", "активный", "", "oleg_k"],
  ]);
  const saved = await db.select().from(contacts).where(eq(contacts.listId, list.id));
  const anna = saved.find((x) => x.name === "Анна Иванова")!;

  const [o] = await db
    .insert(outreach)
    .values({ clientId: c.id, listId: list.id, name: "После вебинара", mode: "email", channelId: mail.id, brief: "Общее задание", groupBriefs: { активный: "Пригласить на консультацию", пассивный: "Прислать запись вебинара" }, research: true })
    .returning();
  await generateOutreach(o.id);
  const drafts = await db.select().from(outreachMessages).where(eq(outreachMessages.outreachId, o.id));
  const [oAfter] = await db.select().from(outreach).where(eq(outreach.id, o.id));

  // Одобрить и отправить днём (12:00 по Киеву)
  await db.update(outreachMessages).set({ status: "approved" }).where(eq(outreachMessages.outreachId, o.id));
  await db.update(outreach).set({ status: "sending" }).where(eq(outreach.id, o.id));
  const night = await sendOutreachTick(new Date("2026-10-24T22:00:00Z"));
  const sentN = await sendOutreachTick(new Date("2026-10-24T09:00:00Z"));
  const { testOutbox } = await import("@/lib/channels/email-send");
  const annaMail = testOutbox.find((m) => m.to === "anna@corp.example");
  const [annaConv] = await db.select().from(conversations).where(eq(conversations.externalId, "anna@corp.example"));
  const annaMsgs = annaConv ? await db.select().from(messages).where(eq(messages.conversationId, annaConv.id)) : [];
  const [oDone] = await db.select().from(outreach).where(eq(outreach.id, o.id));

  // «стоп» в ответ — отписка; повторная рассылка ему не уходит
  const { addMessage } = await import("@/lib/conversations");
  await addMessage(annaConv.id, "user", "стоп");
  const [annaAfter] = await db.select().from(contacts).where(eq(contacts.id, anna.id));

  // Режим «в чаты»: Олег найден по @нику
  const [o2] = await db.insert(outreach).values({ clientId: c.id, listId: list.id, name: "В чаты", mode: "chats", brief: "Напомнить о записи" }).returning();
  await generateOutreach(o2.id);
  await db.update(outreachMessages).set({ status: "approved" }).where(eq(outreachMessages.outreachId, o2.id));
  await db.update(outreach).set({ status: "sending" }).where(eq(outreach.id, o2.id));
  await sendOutreachTick(new Date("2026-10-24T09:00:00Z"));
  const chats = await db.select({ status: outreachMessages.status, error: outreachMessages.error, name: contacts.name }).from(outreachMessages).innerJoin(contacts, eq(contacts.id, outreachMessages.contactId)).where(eq(outreachMessages.outreachId, o2.id));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  await db.delete(conversations).where(eq(conversations.clientId, c.id));
  if (services === undefined) await db.delete(settings).where(eq(settings.key, "services"));
  else await setSetting("services", services);
  stub.close();

  const annaPrompt = prompts.find((p) => p.includes("Анна Иванова")) ?? "";
  const borisPrompt = prompts.find((p) => p.includes("Контакт: Борис")) ?? "";
  const result: Record<string, boolean> = {
    "столбцы узнаны, без контактов — пропущен, ник с @, почта строчными": count === 3 && anna.email === "anna@corp.example" && anna.company === "Corp" && anna.grp === "активный" && anna.fields["Должность"] === "директор" && saved.some((x) => x.telegram === "@oleg_k"),
    "исследование компании и факты в письме": searches >= 1 && annaPrompt.includes("открыла офис в Валенсии") && drafts.find((d) => d.contactId === anna.id)?.research.includes("Валенсии") === true,
    "задание группы: активным — консультация, пассивным — запись": annaPrompt.includes("Пригласить на консультацию") && borisPrompt.includes("Прислать запись вебинара"),
    "почтовая рассылка: черновики только тем, у кого есть почта, статус «на проверке»": drafts.length === 2 && drafts.every((d) => d.status === "ready") && oAfter.status === "review",
    "ночью не отправляет, днём — отправляет с почты клиента": night === 0 && sentN === 2 && annaMail?.from === "sales@test.local" && annaMail.subject === "Для Анна Иванова" && annaMail.text.includes("ответьте «стоп»"),
    "письмо сохранено в разговоре (ответ увидит агент), рассылка завершена": annaMsgs.some((m) => m.role === "assistant" && m.text.includes("Письмо по делу")) && oDone.status === "done",
    "«стоп» в ответ — контакт отписан": annaAfter.unsubscribed === true,
    "в чаты: Олег найден по @нику, без чата — пропущены": tg.some((x) => x.chat === "777") && chats.find((x) => x.name === "Олег")?.status === "sent" && chats.filter((x) => x.status === "skipped").length >= 1,
  };
  void tgConv;
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
