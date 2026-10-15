/** Голосовые ответы: текст для озвучки и запрос к OpenAI TTS (сервер OpenAI — заглушка).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-speech.ts */
import http from "node:http";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const seen: { url: string; auth: string; body: Record<string, string> }[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "audio/ogg" });
      res.end(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(400, 1)]));
    });
  });
  await new Promise<void>((r) => stub.listen(4021, r));
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4021/v1";

  const { speakableText, synthesize, speechAvailable } = await import("@/lib/speech");
  delete process.env.OPENAI_API_KEY;
  const noKey = await synthesize("Привіт!", { voice: "marin" });
  const availableWithout = speechAvailable();
  process.env.OPENAI_API_KEY = "sk-test";
  const audio = await synthesize("Пак з 10 стікерів — від 2000 грн. Деталі: https://yabot.ua/prices [[ACTION suggest: Як замовити?]]", {
    voice: "nonexistent",
    language: "uk",
  });
  const long = speakableText("Речення номер один. ".repeat(100));
  stub.close();

  const req = seen[0];
  const checks: Record<string, boolean> = {
    "без ключа — без голоса": noKey === null && !availableWithout && seen.length === 1,
    "запрос к TTS: модель, формат голосовых Telegram": req?.url === "/v1/audio/speech" && req.body.model === "gpt-4o-mini-tts" && req.body.response_format === "opus",
    "ключ в заголовке": req?.auth === "Bearer sk-test",
    "неизвестный голос → marin": req?.body.voice === "marin",
    "без ссылок и служебных меток": req?.body.input === "Пак з 10 стікерів — від 2000 грн. Деталі:",
    "язык в указаниях голосу": String(req?.body.instructions).includes("українській"),
    "OGG в base64": Boolean(audio) && Buffer.from(audio!, "base64").subarray(0, 4).toString() === "OggS",
    "длинный текст — до конца предложения": long.length <= 1200 && long.endsWith("."),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
