/** WhatsApp: в 24-часовом окне — текст, позже — утверждённый шаблон с нашим текстом в {{1}}, без шаблона — понятная
 *  ошибка; каждое исходящее — в расходы клиента по цене канала; загрузка утверждённых шаблонов из Meta.
 *  Meta — заглушка.  DB_PATH=<копия caltest> npx tsx scripts/test-wa-econ.ts */
import http from "node:http";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages, usageLog } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: Record<string, unknown>[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.includes("/message_templates"))
        return res.end(
          JSON.stringify({
            data: [
              { name: "reminder_ua", language: "uk", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Вітаємо! {{1}}" }] },
              { name: "promo", language: "uk", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "Знижка" }] },
            ],
          }),
        );
      sent.push(JSON.parse(body || "{}"));
      res.end(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(4075, r));
  process.env.WHATSAPP_GRAPH_URL = "http://127.0.0.1:4075";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "WA Econ Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "wa-agent" }).returning();
  const [ch] = await db
    .insert(channels)
    .values({ agentId: a.id, clientId: c.id, type: "whatsapp", name: "wa", config: { token: "t", phoneNumberId: "pn", displayPhone: "+380", wabaId: "123456789", price: { service: 0.05, template: 0.06 } } as never })
    .returning();
  const mk = async (ext: string, hoursAgo: number) => {
    const [conv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "whatsapp", externalId: ext, contactName: ext }).returning();
    await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "привет", createdAt: new Date(Date.now() - hoursAgo * 3600_000) } as never);
    return conv;
  };
  const fresh = await mk("380111", 2);
  const old = await mk("380222", 30);

  // Загрузка шаблонов (только утверждённые) и выбор шаблона
  const { listTemplates } = await import("@/lib/channels/meta/whatsapp");
  const templates = await listTemplates("t", "123456789");
  const { deliver } = await import("@/lib/conversations");
  const load = async () => (await db.select().from(channels).where(eq(channels.id, ch.id)))[0];

  // Без шаблона: в окне — текст, вне окна — ошибка
  await deliver(await load(), fresh, "Ваш заказ готов");
  let closedError = "";
  await deliver(await load(), old, "Напоминаем об оплате").catch((e) => (closedError = e instanceof Error ? e.message : String(e)));
  // С шаблоном: вне окна — шаблон с текстом в {{1}}
  const cur = await load();
  await db.update(channels).set({ config: { ...(cur.config as object), templates, proactiveTemplate: { name: "reminder_ua", language: "uk" } } as never }).where(eq(channels.id, ch.id));
  await deliver(await load(), old, "Нагадуємо про оплату рахунку №5");
  const usage = await db.select().from(usageLog).where(and(eq(usageLog.clientId, c.id), like(usageLog.model, "whatsapp:%")));

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();

  const tpl = sent.find((x) => x.type === "template") as { template?: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] } } | undefined;
  const result: Record<string, boolean> = {
    "шаблоны: только утверждённые, число переменных": templates.length === 1 && templates[0].name === "reminder_ua" && templates[0].params === 1,
    "в 24-часовом окне — обычный текст": sent.some((x) => x.type === "text" && (x.text as { body: string }).body === "Ваш заказ готов"),
    "вне окна без шаблона — ошибка «окно закрыто»": closedError === "wa_window_closed",
    "вне окна — шаблон с нашим текстом в {{1}}": tpl?.template?.name === "reminder_ua" && tpl.template.language.code === "uk" && tpl.template.components[0].parameters[0].text === "Нагадуємо про оплату рахунку №5",
    "каждое исходящее — в расходы по цене канала": usage.length === 2 && usage.some((u) => u.model === "whatsapp:service" && u.cost === 0.05) && usage.some((u) => u.model === "whatsapp:template" && u.cost === 0.06),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
