/** Встречи и звонки: субтитры чистятся, запись расшифровывается (gpt-4o-transcribe, при сбое — whisper-1),
 *  разбор сохраняется (итоги, задачи, оценка), итоги уходят в Telegram, строка для Google Таблицы.
 *  OpenAI, модель и Telegram — макеты. DB_PATH=<копия caltest> npx tsx scripts/test-meetings.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, meetings, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: { chat: string; text: string }[] = [];
  const asr: string[] = [];
  let system = "";
  let prompt = "";
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url?.startsWith("/bot")) {
        const b = JSON.parse(raw.toString());
        tg.push({ chat: String(b.chat_id), text: b.text });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      if (req.url?.includes("/audio/transcriptions")) {
        const model = raw.toString("latin1").match(/name="model"\r\n\r\n([^\r]+)/)?.[1] ?? "";
        asr.push(model);
        if (model === "gpt-4o-transcribe") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "unsupported", type: "invalid_request_error" } }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ text: "Олег: Запускаем рекламу в понедельник. Анна, подготовь тексты до пятницы." }));
      }
      const b = JSON.parse(raw.toString());
      system = b.system;
      prompt = b.messages[0].content;
      const data = {
        title: "Планёрка по рекламе",
        summary: "Решили запустить рекламу в понедельник.",
        result: "## Кратко\nЗапуск рекламы в понедельник.\n## Задачи\n- Анна — тексты до пятницы",
        tasks: [{ who: "Анна", what: "Подготовить тексты рекламы", due: "пятница" }, { who: "", what: " ", due: "" }],
        score: null,
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: JSON.stringify(data) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4059, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4059";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4059/v1";
  process.env.OPENAI_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4059";
  const notify = await getSetting("notify");
  const [agent] = await db.select().from(agents).limit(1);
  await setSetting("notify", { token: "stub", botUsername: "n", linkCode: "x", adminUrl: "", subscribers: [{ chatId: "900", name: "studio", since: 0 }], owners: [{ chatId: "777", name: "Владелец", since: 0, clientId: agent.clientId }] });

  const { cleanSubtitles, processMeeting, transcriptFromFile } = await import("@/lib/meetings/engine");
  const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Иван>Добрый день</v>\n\n2\n00:00:03.000 --> 00:00:05.000\n<v Иван>Добрый день</v>\n\n3\n00:00:05.000 --> 00:00:07.000\nНачнём с бюджета\n";
  const cleaned = cleanSubtitles(vtt);
  const fromVtt = await transcriptFromFile(Buffer.from(vtt), "call.vtt");

  const [m] = await db.insert(meetings).values({ clientId: agent.clientId, kind: "sales", instructions: "Назначил следующий шаг", delivery: { team: true, owners: true } }).returning();
  const done = await processMeeting(m.id, { buf: Buffer.from("fake-audio"), filename: "call.m4a", audio: true });
  const [saved] = await db.select().from(meetings).where(eq(meetings.id, m.id));

  delete process.env.OPENAI_API_KEY;
  const [m2] = await db.insert(meetings).values({ clientId: agent.clientId }).returning();
  await processMeeting(m2.id, { buf: Buffer.from("x"), filename: "a.mp3", audio: true });
  const [failed] = await db.select().from(meetings).where(eq(meetings.id, m2.id));

  const { sheetRow } = await import("@/lib/integrations/events");
  const row = sheetRow({
    event: "meeting",
    at: new Date().toISOString(),
    client: { id: "c", name: "C" },
    agent: null,
    channel: null,
    conversation: null,
    meeting: { title: saved.title, kind: saved.kind, summary: saved.summary, tasks: saved.tasks, score: 7 },
  });

  await db.delete(meetings).where(eq(meetings.id, m.id));
  await db.delete(meetings).where(eq(meetings.id, m2.id));
  if (notify === undefined) await db.delete(settings).where(eq(settings.key, "notify"));
  else await setSetting("notify", notify);
  stub.close();

  const result: Record<string, boolean> = {
    "субтитры: без таймкодов и номеров, говорящий, без повторов": cleaned === "Иван: Добрый день\nНачнём с бюджета" && fromVtt === cleaned,
    "расшифровка: сбой gpt-4o-transcribe → whisper-1": asr.join(",") === "gpt-4o-transcribe,whisper-1" && saved.transcript.includes("Анна, подготовь тексты"),
    "модели — вид разбора, чек-лист, расшифровка": system.includes("Разбери звонок продаж") && system.includes("Назначил следующий шаг") && prompt.includes("Запускаем рекламу"),
    "разбор сохранён: название, итоги, задачи без пустых": Boolean(done) && saved.status === "done" && saved.title === "Планёрка по рекламе" && saved.tasks.length === 1 && saved.tasks[0].who === "Анна" && saved.result.includes("## Кратко"),
    "итоги в Telegram студии и владельцу": tg.some((x) => x.chat === "900" && x.text.includes("Планёрка по рекламе") && x.text.includes("Анна")) && tg.some((x) => x.chat === "777" && x.text.includes("до пятница")),
    "без ключа OpenAI — понятная ошибка в статусе": failed.status === "error" && failed.error === "no_openai",
    "строка для таблицы: событие, итоги, задачи, оценка": row[1] === "Встреча: Планёрка по рекламе" && row.join(" ").includes("Анна: Подготовить тексты рекламы (до пятница)") && row.join(" ").includes("оценка 7/10"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
