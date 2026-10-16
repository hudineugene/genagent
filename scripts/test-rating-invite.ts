/** Просьба оценить ответ: подсказка агенту — пока он не просил; метка ask_rating не уходит боту; выключено — нет
 *  (модель — заглушка). DB_PATH=<копия caltest> npx tsx scripts/test-rating-invite.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const queue: string[] = [];
  const systems: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      const sys = JSON.stringify(b.system ?? "");
      const json = sys.includes("Заполни карточку");
      if (!json) systems.push(sys);
      const text = json ? JSON.stringify({ temperature: "cold", reason: "", fields: [] }) : (queue.shift() ?? "Ответ");
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
  await new Promise<void>((r) => stub.listen(4035, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4035";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [agent] = await db.select().from(agents).limit(1);
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
  const key = "ga_rating-test-key-0123456789";
  const mkChannel = async (ratingInvite: boolean) =>
    (await db.insert(channels).values({ agentId: agent.id, clientId: agent.clientId, type: "api", name: "rating-test", config: { key, label: "@rating_test_bot", ratingInvite } }).returning())[0];
  const on = await mkChannel(true);
  const off = await mkChannel(false);
  const route = await import("@/app/api/agent/[channelId]/route");
  const ask = (ch: string, text: string) =>
    route
      .POST(
        new Request(`http://x/api/agent/${ch}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ user: { id: "rating-user", name: "Олена" }, text }),
        }),
        { params: Promise.resolve({ channelId: ch }) },
      )
      .then((r) => r.json());

  queue.push("Будь ласка! Якщо я допоміг — відмітьте 👍 під цим повідомленням.\n[[ACTION ask_rating: yes]]");
  const r1 = await ask(on.id, "Дякую, все зрозуміло");
  const sys1 = systems.at(-1) ?? "";
  const [c1] = await db.select().from(conversations).where(eq(conversations.channelId, on.id));
  queue.push("Звертайтеся!");
  await ask(on.id, "Ще раз дякую");
  const sys2 = systems.at(-1) ?? "";
  queue.push("Будь ласка!");
  await ask(off.id, "Дякую");
  const sys3 = systems.at(-1) ?? "";

  for (const ch of [on, off]) {
    for (const c of await db.select().from(conversations).where(eq(conversations.channelId, ch.id))) {
      await db.delete(messages).where(eq(messages.conversationId, c.id));
      await db.delete(conversations).where(eq(conversations.id, c.id));
    }
    await db.delete(channels).where(eq(channels.id, ch.id));
  }
  stub.close();

  const checks: Record<string, boolean> = {
    "агенту — подсказка про оценку": sys1.includes("Оценка ответа"),
    "клиент видит просьбу, метка — нет": typeof r1.reply === "string" && r1.reply.includes("👍") && !r1.reply.includes("[[ACTION"),
    "метка не уходит боту в действия": !(r1.actions ?? []).some((a: { type: string }) => a.type === "ask_rating"),
    "разговор запомнил, что оценку просили": Boolean(c1.context?.ratingAskedAt),
    "второй раз в этом разговоре — не просит": !sys2.includes("Оценка ответа"),
    "настройка выключена — подсказки нет": !sys3.includes("Оценка ответа"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
