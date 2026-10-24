/** Голос в виджете: выключен — адрес распознавания закрыт; включён — запись → текст (распознавание — заглушка),
 *  настройка видна окну чата, сообщение помечено голосовым, окну разрешён микрофон, не больше 10 записей в минуту.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-widget-voice.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, messages } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  process.env.ASR_TEST_TEXT = "Сколько стоит доставка в Одессу";
  const VISITOR = crypto.randomUUID();
  const [c] = await db.insert(clients).values({ name: "Widget Voice" }).returning();
  const [a] = await db.insert(agents).values({ clientId: c.id, name: "wv", status: "paused", config: agentConfigSchema.parse({ model: "anthropic:claude-haiku-5-5" }) }).returning();
  const cfg = { title: "Чат", subtitle: "", color: "#5b5bf0", position: "right" as const };
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: cfg }).returning();
  const voice = await import("@/app/api/widget/[channelId]/voice/route");
  const widget = await import("@/app/api/widget/[channelId]/route");
  const body = JSON.stringify({ visitor: VISITOR, lang: "ru", data: "A".repeat(200) });
  const call = (ip: string) => voice.POST(new Request("https://x", { method: "POST", body, headers: { "content-type": "application/json", "x-forwarded-for": ip } }), { params: Promise.resolve({ channelId: ch.id }) });
  const off = await call("1.1.1.1");
  await db.update(channels).set({ config: { ...cfg, voice: true } }).where(eq(channels.id, ch.id));
  const on = await call("1.1.1.2");
  const onJson = await on.json();
  const get = await widget.GET(new Request(`https://x/api/widget/${ch.id}`), { params: Promise.resolve({ channelId: ch.id }) });
  const g = await get.json();
  await widget.POST(new Request("https://x", { method: "POST", body: JSON.stringify({ visitor: VISITOR, text: onJson.text, voice: true }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ channelId: ch.id }) });
  const [conv] = await db.select().from(conversations).where(eq(conversations.channelId, ch.id));
  const [m] = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await call("9.9.9.9")).status);
  const js = await (await import("@/app/widget.js/route")).GET();
  const script = await js.text();

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));

  const r: Record<string, boolean> = {
    "голос выключен — адрес закрыт": off.status === 404,
    "запись → текст": on.status === 200 && onJson.text === "Сколько стоит доставка в Одессу",
    "окно чата знает, что голос включён": g.config.voice === true,
    "сообщение помечено голосовым": m.text === "Сколько стоит доставка в Одессу" && m.meta?.kind === "voice",
    "не больше 10 записей в минуту": statuses.slice(0, 10).every((s) => s === 200) && statuses[10] === 429,
    "окну чата разрешён микрофон": script.includes("microphone"),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
