/** Отчёт за месяц: спрос по карточкам лидов и рассылка владельцу клиента напрямую (Telegram — заглушка, без ИИ).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-report-leads.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, settings } from "@/db/schema";
import { clientReport, clientReportHtml, monthRange, sendMonthlyReports } from "@/lib/agent/report";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const docs: { chat: string; caption: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (String(req.url).endsWith("/sendDocument")) {
        const field = (name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1] ?? "";
        docs.push({ chat: field("chat_id"), caption: field("caption") });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(4034, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4034";

  const month = "2026-09";
  const { from } = monthRange(month);
  const [ch] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  const lead = (temperature: "hot" | "warm" | "cold", fields: [string, string][]) => ({
    temperature,
    reason: "тест",
    fields: fields.map(([label, value]) => ({ label, value })),
    at: from + 5 * 864e5,
    upto: from + 5 * 864e5,
  });
  const made: string[] = [];
  for (const l of [
    lead("hot", [["Что ищет", "вилла с бассейном"], ["Бюджет", "до 600 000 €"], ["Контакт", "оставил телефон"]]),
    lead("warm", [["Что ищет", "Вилла с бассейном"], ["Бюджет", "до 400 000 €"]]),
    lead("cold", [["Что ищет", "апартаменты у моря"]]),
  ]) {
    const [c] = await db
      .insert(conversations)
      .values({ clientId: ch.clientId, agentId: ch.agentId, channelId: ch.id, channelType: "widget", externalId: crypto.randomUUID(), context: { lead: l } } as never)
      .returning();
    made.push(c.id);
    await db.insert(messages).values({ conversationId: c.id, role: "user", text: "Ищу виллу", status: "sent", createdAt: new Date(from + 5 * 864e5) } as never);
  }

  const [oldNotify] = await db.select().from(settings).where(eq(settings.key, "notify"));
  const value = {
    token: "123:TEST",
    botUsername: "t_bot",
    linkCode: "x",
    adminUrl: "https://admin.example",
    subscribers: [{ chatId: "777", name: "Студия", since: 1 }],
    owners: [
      { chatId: "900", name: "Владелец", since: 1, clientId: ch.clientId },
      { chatId: "901", name: "Чужой владелец", since: 1, clientId: "00000000-0000-0000-0000-000000000000" },
    ],
  };
  await db.insert(settings).values({ key: "notify", value, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value } });

  const r = await clientReport(ch.clientId, month);
  const html = r ? clientReportHtml(r) : "";
  const sent = await sendMonthlyReports(month);

  for (const id of made) {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
  if (oldNotify) await db.update(settings).set({ value: oldNotify.value }).where(eq(settings.key, "notify"));
  else await db.delete(settings).where(eq(settings.key, "notify"));
  server.close();

  const what = r?.leads.demand.find((d) => d.label === "Что ищет");
  const checks: Record<string, boolean> = {
    "горячие / тёплые / холодные": r?.leads.hot === 1 && r.leads.warm === 1 && r.leads.cold === 1,
    "частое значение склеено без учёта регистра": what?.values[0].value.toLowerCase() === "вилла с бассейном" && what.values[0].count === 2,
    "контакты в спрос не попадают": !r?.leads.demand.some((d) => /контакт/i.test(d.label)),
    "раздел в отчёте": html.includes("Кого привёл агент") && html.includes("🔥 1") && html.includes("вилла с бассейном (2)"),
    "владелец получил отчёт напрямую, с понятной подписью": sent >= 1 && docs.some((d) => d.chat === "900" && d.caption.includes("Откройте файл в браузере")),
    "чужой владелец — не получил": !docs.some((d) => d.chat === "901"),
    "студия — как раньше, с подсказкой переслать": docs.some((d) => d.chat === "777" && d.caption.includes("перешлите владельцу")),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
