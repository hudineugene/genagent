/** Бриф перед звонком: карточка лида, память и переписка — в задании; компания клиента известна и поиск включён —
 *  ищет её новости; кнопка «Бриф» под уведомлением. Модель — макет. DB_PATH=<копия caltest> npx tsx scripts/test-brief.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  let sys = "";
  let user = "";
  let withSearch = false;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      sys = typeof b.system === "string" ? b.system : JSON.stringify(b.system);
      user = String(b.messages[0].content);
      withSearch = Boolean(b.tools?.some((t: { type?: string }) => String(t.type ?? "").startsWith("web_search")));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "## Кто клиент\nИван, ищет виллу до 1 млн €.\n## О чём говорить\nЗаписать на показ." } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4068, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4068";
  process.env.ANTHROPIC_API_KEY = "stub";
  const services = await getSetting("services");
  await setSetting("services", { webSearch: { enabled: true, maxUses: 3 } });

  const [agent] = await db.select().from(agents).limit(1);
  const [ch] = await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "widget", name: "w", config: {} as never }).returning();
  const [conv] = await db
    .insert(conversations)
    .values({
      clientId: agent.clientId,
      agentId: agent.id,
      channelId: ch.id,
      channelType: "widget",
      externalId: "brief-1",
      contactName: "Иван",
      context: {
        lead: { temperature: "hot", reason: "готов к показу", fields: [{ label: "Компания", value: "Acme Group" }, { label: "Бюджет", value: "1 млн €" }], at: Date.now(), upto: Date.now() },
        memory: { facts: ["Двое детей", "Нужен бассейн"], upto: Date.now(), at: Date.now() },
      },
    })
    .returning();
  await db.insert(messages).values([
    { conversationId: conv.id, role: "user", text: "Ищу виллу с бассейном до миллиона" },
    { conversationId: conv.id, role: "assistant", text: "Есть Sierra Verde от 550 000 €" },
  ]);
  const { callBrief } = await import("@/lib/agent/brief");
  const text = await callBrief(conv.id);

  await db.delete(conversations).where(eq(conversations.id, conv.id));
  await db.delete(channels).where(eq(channels.id, ch.id));
  if (services === undefined) await db.delete(settings).where(eq(settings.key, "services"));
  else await setSetting("services", services);
  stub.close();

  const result: Record<string, boolean> = {
    "бриф получен": Boolean(text?.includes("Кто клиент")),
    "в задании: карточка, память, переписка": user.includes("Acme Group") && user.includes("Нужен бассейн") && user.includes("Sierra Verde"),
    "разделы брифа: возражения и о чём говорить": sys.includes("Каких возражений ждать") && sys.includes("О чём говорить"),
    "компания известна и поиск включён — ищет её новости": withSearch && sys.includes("Компания клиента"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
