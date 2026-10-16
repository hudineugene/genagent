/** «Что ещё не настроено» и подсказка «похоже на тест» (модель и Telegram — заглушки).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-setup-checklist.ts */
import http from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, settings } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const sent: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (String(req.url).includes("/bot")) {
        if (String(req.url).endsWith("/sendMessage")) sent.push(String(JSON.parse(body).text));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
        return;
      }
      const text = JSON.stringify({ temperature: "hot", reason: "сам пишет, что тестирует бота", fields: [], test: true });
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
  await new Promise<void>((r) => stub.listen(4037, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4037";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4037";
  delete process.env.OPENAI_API_KEY;

  const keys = ["notify", "testAccounts", "setupDismissed", "waitReminders"];
  const keep = await db.select().from(settings).where(inArray(settings.key, keys));
  const notify = { token: "123:TEST", botUsername: "t_bot", linkCode: "x", adminUrl: "https://admin.example", subscribers: [{ chatId: "777", name: "QA", since: 1 }] };
  await db.insert(settings).values({ key: "notify", value: notify, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: notify } });
  await db.delete(settings).where(inArray(settings.key, ["testAccounts", "setupDismissed"]));
  const open = { enabled: true, firstMin: 20, secondMin: 60, fromHour: 0, toHour: 24 };
  await db.insert(settings).values({ key: "waitReminders", value: open, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: open } });

  const [agent] = await db.select().from(agents).limit(1);
  const oldCfg = agent.config;
  await db.update(agents).set({ status: "active", config: { ...agent.config, leadFields: "" } }).where(eq(agents.id, agent.id));
  const [api] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "api", name: "setup-test", config: { key: "ga_setup-test-key-0123456789", label: "@setup_bot" } }).returning();

  const { setupChecklist, dismissSetupItem } = await import("@/lib/setup-checklist");
  const kinds = async (): Promise<string[]> => (await setupChecklist(agent.id)).map((i) => i.kind);
  const all: string[] = (await setupChecklist()).map((i) => i.kind);
  const before = await kinds();
  await db.update(agents).set({ config: { ...agent.config, leadFields: "Что ищет, Бюджет" } }).where(eq(agents.id, agent.id));
  const afterFields = await kinds();
  await dismissSetupItem(`rating:${agent.id}`);
  const afterDismiss = await kinds();

  // «Похоже на тест»: горячая карточка без оповещения и без сводки лидов
  const [conv] = await db
    .insert(conversations)
    .values({ clientId: agent.clientId, agentId: agent.id, channelId: api.id, channelType: "api", externalId: crypto.randomUUID(), contactName: "Тестер" } as never)
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Я тестирую бота, покажите виллу в субботу", status: "sent" },
    { conversationId: conv.id, role: "assistant", text: "Хорошо", status: "sent" },
  ] as never);
  const { updateLead } = await import("@/lib/agent/lead");
  const lead = await updateLead(conv.id);
  const { collectLeads } = await import("@/lib/agent/leads");
  const inDigest = (await collectLeads(Date.now() - 864e5)).some((l) => l.conversationId === conv.id);

  await db.delete(messages).where(eq(messages.conversationId, conv.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(channels).where(eq(channels.id, api.id));
  await db.update(agents).set({ config: oldCfg, status: agent.status }).where(eq(agents.id, agent.id));
  await db.delete(settings).where(inArray(settings.key, keys));
  for (const k of keep) await db.insert(settings).values(k);
  stub.close();

  const checks: Record<string, boolean> = {
    "общие пункты: тестовые аккаунты": all.includes("testAccounts"),
    "агент: владелец, поля карточки, оценка, голос": ["leadFields", "rating", "voice"].every((k) => before.includes(k)) && (before.includes("owner") || before.includes("gapsWaiting")),
    "поля карточки заданы — пункт исчез": !afterFields.includes("leadFields"),
    "«Не нужно» — пункт скрыт": !afterDismiss.includes("rating") && afterDismiss.includes("voice"),
    "похоже на тест — отмечено": lead?.looksTest === true,
    "похоже на тест — без оповещения": !sent.some((t) => t.includes("Горячий клиент")),
    "похоже на тест — не в сводке лидов": !inDigest,
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
