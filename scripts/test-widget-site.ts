/** Виджет для многоязычного сайта: тексты по языку, подсказки, язык и страница — агенту (модель — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-widget-site.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, messages, type WidgetConfig } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const systems: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      systems.push(JSON.stringify(b.system));
      const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "¡Claro! Villa Sol cuesta 550 000 €." } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4024, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4024";
  process.env.ANTHROPIC_API_KEY = "stub";

  const [ch] = await db.select().from(channels).where(eq(channels.type, "widget")).limit(1);
  if (!ch) throw new Error("нет канала-виджета в тестовой базе");
  const cfg = ch.config as WidgetConfig;
  await db
    .update(channels)
    .set({ config: { ...cfg, quick: ["Подобрать виллу"], locales: { es: { title: "Asesor", greeting: "¡Hola! ¿En qué puedo ayudarte?", quick: ["Buscar villa", "Reservar visita"] } } } })
    .where(eq(channels.id, ch.id));

  const route = await import("@/app/api/widget/[channelId]/route");
  const params = Promise.resolve({ channelId: ch.id });
  const es = await (await route.GET(new Request(`http://x/api/widget/${ch.id}?lang=es`), { params })).json();
  const ru = await (await route.GET(new Request(`http://x/api/widget/${ch.id}?lang=ru`), { params })).json();
  const visitor = crypto.randomUUID();
  const post = await route.POST(
    new Request(`http://x/api/widget/${ch.id}`, {
      method: "POST",
      body: JSON.stringify({ visitor, text: "¿Cuánto cuesta?", lang: "es", page: { url: "https://kornilenko.example/es/villa-sol", title: "Villa Sol — Finestrat" }, context: "Objeto: Villa Sol (V-012), 550 000 €" }),
    }),
    { params },
  );
  // Ответ агента — через паузу сбора сообщений
  let reply;
  for (let i = 0; i < 40 && !reply; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const [c] = await db.select().from(conversations).where(eq(conversations.externalId, visitor));
    if (c) [reply] = (await db.select().from(messages).where(eq(messages.conversationId, c.id))).filter((m) => m.role === "assistant" && m.text.includes("550"));
  }
  const [conv] = await db.select().from(conversations).where(eq(conversations.externalId, visitor));
  const msgs = conv ? await db.select().from(messages).where(eq(messages.conversationId, conv.id)) : [];

  await db.update(channels).set({ config: cfg }).where(eq(channels.id, ch.id));
  if (conv) await db.delete(conversations).where(eq(conversations.id, conv.id));
  stub.close();

  const sys = systems.at(-1) ?? "";
  const checks: Record<string, boolean> = {
    "испанский: заголовок, приветствие, подсказки": es.config.title === "Asesor" && es.config.greeting.startsWith("¡Hola") && es.config.quick.join() === "Buscar villa,Reservar visita",
    "без перевода — основные тексты": ru.config.title === cfg.title && ru.config.quick.join() === "Подобрать виллу",
    "сообщение принято": post.status === 200,
    "приветствие сохранено на языке страницы": msgs.some((m) => m.role === "assistant" && m.text.startsWith("¡Hola")),
    "язык и страница — в разговоре": conv?.context?.language === "es" && Boolean(conv?.context?.botContext?.includes("Villa Sol — Finestrat")),
    "агент знает язык сайта и что смотрит посетитель": sys.includes("Сайт открыт на языке: español") && sys.includes("Objeto: Villa Sol (V-012)") && sys.includes("чат на сайте"),
    "агент ответил": Boolean(reply),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
