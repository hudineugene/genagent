/** Картинки и публикация: генерация (OpenAI) и сохранение под неугадываемым именем, публичная отдача /m/<имя>,
 *  Telegram — фото с подписью (длинный текст — следом сообщением), Threads — пост с картинкой по публичной ссылке
 *  (ожидание обработки, ссылка на пост), ограничения длины. OpenAI, Telegram и Threads — макеты.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-content-media.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, contentItems } from "@/db/schema";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { method: string; chat: string; caption?: string; text?: string; hasPhoto: boolean }[] = [];
  const threads: { path: string; body: string }[] = [];
  let imagePrompt = "";
  let statusPolls = 0;
  const stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const json = (o: object) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? "";
      if (url.startsWith("/bot")) {
        const method = url.split("/").pop() ?? "";
        if (method === "sendPhoto") {
          const s = raw.toString("latin1");
          const field = (n: string) => s.match(new RegExp(`name="${n}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1];
          tg.push({ method, chat: field("chat_id") ?? "", caption: field("caption") ? Buffer.from(field("caption")!, "latin1").toString("utf8") : undefined, hasPhoto: s.includes('name="photo"; filename=') });
        } else {
          const b = JSON.parse(raw.toString() || "{}");
          tg.push({ method, chat: String(b.chat_id), text: b.text, hasPhoto: false });
        }
        return json({ ok: true, result: { message_id: 77, chat: { username: "test_channel" } } });
      }
      if (url.includes("/images/generations")) {
        imagePrompt = JSON.parse(raw.toString()).prompt;
        return json({ created: 1, data: [{ b64_json: PNG.toString("base64") }] });
      }
      // Threads
      threads.push({ path: `${req.method} ${url.split("?")[0]}`, body: raw.toString() });
      if (url.includes("/me/threads_publish")) return json({ id: "post_1" });
      if (url.includes("/me/threads")) return json({ id: "container_1" });
      if (url.includes("/container_1")) {
        statusPolls++;
        return json({ status: statusPolls < 2 ? "IN_PROGRESS" : "FINISHED" });
      }
      if (url.includes("/post_1")) return json({ permalink: "https://www.threads.com/@acc/post/abc" });
      json({});
    });
  });
  await new Promise<void>((r) => stub.listen(4062, r));
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4062";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4062/v1";
  process.env.OPENAI_API_KEY = "stub";
  process.env.THREADS_GRAPH_URL = "http://127.0.0.1:4062";
  process.env.THREADS_WAIT_SCALE = "0.01";
  process.env.PUBLIC_URL = "https://agents.example.com";

  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const [tgCh] = await db.insert(channels).values({ agentId: agent.id, clientId: client.id, type: "telegram", name: "media-bot", config: { token: "123:test" } as never, enabled: false }).returning();
  const [thCh] = await db.insert(channels).values({ agentId: agent.id, clientId: client.id, type: "threads", name: "@acc", config: { threadsUserId: "1", username: "acc", token: "th-token", tokenExpiresAt: Date.now() + 1e9, approval: false } as never, enabled: false }).returning();

  const { generateContentImage, defaultImagePrompt, readContentImage, CONTENT_IMAGE_NAME } = await import("@/lib/content/images");
  const { publishItem } = await import("@/lib/content/studio");
  const route = await import("@/app/m/[name]/route");

  const prompt = defaultImagePrompt({ title: "Вилла с видом на море", brief: "", client: client.name, industry: "недвижимость" });
  const name = await generateContentImage(prompt);
  const served = await route.GET(new Request(`http://x/m/${name}`), { params: Promise.resolve({ name }) });
  const bad = await route.GET(new Request("http://x/m/../genagent.db"), { params: Promise.resolve({ name: "../genagent.db" }) });

  const mk = async (v: Partial<typeof contentItems.$inferInsert>) => (await db.insert(contentItems).values({ clientId: client.id, text: "x", ...v }).returning())[0];
  const short = await mk({ text: "**Riviera 2** — вид на море", image: name, channelId: tgCh.id, target: "@test_channel" });
  const long = await mk({ text: "Длинный пост. ".repeat(120), image: name, channelId: tgCh.id, target: "@test_channel" });
  const th = await mk({ platform: "threads", text: "**Новый объект** в Финестрате", image: name, channelId: thCh.id });
  const thLong = await mk({ platform: "threads", text: "a".repeat(600), channelId: thCh.id });

  const rShort = await publishItem(short.id);
  const rLong = await publishItem(long.id);
  const rTh = await publishItem(th.id);
  const rThLong = await publishItem(thLong.id);
  delete process.env.PUBLIC_URL;
  const thNoUrl = await mk({ platform: "threads", text: "пост", image: name, channelId: thCh.id });
  const rNoUrl = await publishItem(thNoUrl.id);

  const created = threads.find((x) => x.path.endsWith("/me/threads"));
  const sent = new URLSearchParams(created?.body ?? "");
  await db.delete(contentItems).where(eq(contentItems.clientId, client.id));
  await db.delete(channels).where(eq(channels.id, tgCh.id));
  await db.delete(channels).where(eq(channels.id, thCh.id));
  const { removeContentImage } = await import("@/lib/content/images");
  removeContentImage(name);
  stub.close();

  const result: Record<string, boolean> = {
    "картинка: подсказка без текста на картинке, неугадываемое имя": imagePrompt.includes("Вилла с видом на море") && imagePrompt.includes("no text") && CONTENT_IMAGE_NAME.test(name) && readContentImage(name) !== null,
    "публичная отдача /m/: картинка — да, чужой файл — 404": served.status === 200 && served.headers.get("content-type") === "image/png" && bad.status === 404,
    "Telegram: фото с подписью в HTML": rShort.ok && rShort.url === "https://t.me/test_channel/77" && tg[0]?.method === "sendPhoto" && tg[0].hasPhoto && tg[0].caption?.includes("<b>Riviera 2</b>") === true,
    "Telegram: длинный текст — фото без подписи и текст следом": rLong.ok && tg[1]?.method === "sendPhoto" && !tg[1].caption && tg[2]?.method === "sendMessage" && (tg[2].text?.length ?? 0) > 1024,
    "Threads: картинка по публичной ссылке, текст без разметки": rTh.ok && sent.get("media_type") === "IMAGE" && sent.get("image_url") === `https://agents.example.com/m/${name}` && sent.get("text") === "Новый объект в Финестрате",
    "Threads: ждёт обработки картинки и возвращает ссылку на пост": statusPolls >= 2 && rTh.url === "https://www.threads.com/@acc/post/abc" && threads.some((x) => x.path.endsWith("/me/threads_publish")),
    "Threads: больше 500 знаков — ошибка без отправки": !rThLong.ok && rThLong.error === "too_long_threads",
    "Threads без публичного адреса — понятная ошибка": !rNoUrl.ok && rNoUrl.error === "no_public_url",
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
