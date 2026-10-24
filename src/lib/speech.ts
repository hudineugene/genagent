import "server-only";
import { apiKey } from "@/lib/keys";
import OpenAI from "openai";
import { db } from "@/db";
import { usageLog } from "@/db/schema";

/**
 * Голосовые ответы агента: клиент прислал голосовое — агент отвечает голосовым (и тем же текстом под ним).
 * Озвучивает OpenAI gpt-4o-mini-tts (ключ OPENAI_API_KEY в secrets.env сервера) сразу в OGG/Opus —
 * формат голосовых Telegram. Около $0.015 за минуту речи. Нет ключа — бот отвечает текстом, как раньше.
 */
const MODEL = "gpt-4o-mini-tts";
export const VOICES = ["marin", "cedar", "coral", "nova", "shimmer", "sage", "ash", "ballad", "verse", "echo", "onyx", "alloy"] as const;
export type Voice = (typeof VOICES)[number];
const MAX_CHARS = 1200;
/** Примерно столько символов в минуту речи — для оценки стоимости (OpenAI не возвращает длительность) */
const CHARS_PER_MINUTE = 900;
const USD_PER_MINUTE = 0.015;
const LANGS: Record<string, string> = { ru: "русском", uk: "українській", en: "English", es: "español" };

export function speechAvailable() {
  return Boolean(apiKey("openai"));
}

/** Текст для озвучки: без ссылок, служебных меток и разметки; длинный — до последнего законченного предложения. */
export function speakableText(text: string): string {
  let s = text
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_#`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_CHARS) {
    const cut = s.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = end > MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut;
  }
  return s;
}

let client: OpenAI | null = null;

/** Голосовое (OGG/Opus, base64) или null — нет ключа, нечего озвучивать или OpenAI не ответил. */
export async function synthesize(
  text: string,
  opts: { voice?: string; language?: string; agentId?: string; clientId?: string; conversationId?: string },
): Promise<string | null> {
  const key = apiKey("openai");
  const input = speakableText(text);
  if (!key || input.length < 2) return null;
  client ??= new OpenAI({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL || undefined });
  const voice = VOICES.includes(opts.voice as Voice) ? (opts.voice as Voice) : "marin";
  const lang = LANGS[opts.language ?? ""];
  const started = Date.now();
  try {
    const res = await client.audio.speech.create(
      {
        model: MODEL,
        voice,
        input,
        response_format: "opus",
        instructions: `Ты консультант компании и отвечаешь клиенту голосовым сообщением${lang ? ` на ${lang}` : ""}. Говори тепло и естественно, как живой человек, в спокойном темпе, с правильным ударением; числа, цены и даты произноси чётко.`,
      },
      { timeout: 25_000 },
    );
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    await db
      .insert(usageLog)
      .values({
        source: "channel",
        model: `openai:${MODEL}`,
        agentId: opts.agentId ?? null,
        clientId: opts.clientId ?? null,
        conversationId: opts.conversationId ?? null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cost: (input.length / CHARS_PER_MINUTE) * USD_PER_MINUTE,
        ms: Date.now() - started,
      })
      .catch(() => {});
    return buf.toString("base64");
  } catch (e) {
    console.error("speech failed", e instanceof Error ? e.message : e);
    return null;
  }
}
