import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { DB_PATH } from "@/db/client";
import { logUsage } from "@/lib/usage";

/**
 * Фото в переписке своих ботов: превью для «Диалогов» (файлы рядом с базой, папка media) и описание фото
 * дешёвой моделью — агент отвечает с учётом того, что прислал клиент.
 */
export const MEDIA_DIR = path.join(path.dirname(DB_PATH), "media");
const MAX_THUMB_BYTES = 400 * 1024;
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
export type ImageType = keyof typeof TYPES;
export const MEDIA_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** Сохранить превью сообщения; вернуть имя файла или null (не картинка / слишком большая). */
export function saveThumb(messageId: string, base64: string, type: string): string | null {
  const ext = TYPES[type as ImageType];
  if (!ext) return null;
  const buf = Buffer.from(base64, "base64");
  if (!buf.length || buf.length > MAX_THUMB_BYTES) return null;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const name = `${messageId}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return name;
}

const DESCRIBE_MODEL = "claude-haiku-5-5";

/**
 * Что на фото — для консультанта компании: предмет, детали, надписи. 2–4 предложения, без советов.
 * null — не вышло (нет ключа, ошибка).
 */
async function describePhoto__(
  image: string,
  mediaType: ImageType,
  owner: { agentId: string | null; clientId: string },
  caption?: string,
): Promise<string | null> {
  const key = apiKey("anthropic");
  if (!key) return null;
  const started = Date.now();
  try {
    const client = new Anthropic({ apiKey: key });
    // Модель сперва размышляет: при маленьком max_tokens размышление съедало весь лимит, и описание
    // приходило пустым или обрывалось («На фото»). Запас токенов + низкое усилие.
    const res = await client.messages.create({
      model: DESCRIBE_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system:
        "Ты описываешь фотографию, которую клиент прислал в чат компании, для консультанта, который её не видит. " +
        "Опиши по-русски в 2–4 предложениях, что на фото: главный предмет, важные детали (вид, стиль, состояние, цвета, " +
        "люди или животные, обстановка) и весь заметный текст дословно. Без оценок, догадок о намерениях и советов.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: caption ? `Подпись клиента к фото: «${caption.slice(0, 300)}»` : "Подписи нет." },
          ],
        },
      ],
    });
    await logUsage({
      source: "insights",
      model: `anthropic:${DESCRIBE_MODEL}`,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0 },
      agentId: owner.agentId,
      clientId: owner.clientId,
      ms: Date.now() - started,
    }).catch(() => {});
    let text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    // Обрезано лимитом — оставляем законченные предложения
    if (res.stop_reason === "max_tokens") text = text.slice(0, text.search(/[.!?»][^.!?»]*$/) + 1).trim();
    if (text.length > 800) text = text.slice(0, 800);
    return text.length >= 15 ? text : null;
  } catch (e) {
    console.error("describe photo failed", e);
    return null;
  }
}

/** describePhoto — в области ключей клиента (его ключи ИИ, если заданы). */
export async function describePhoto(...a: Parameters<typeof describePhoto__>): ReturnType<typeof describePhoto__> {
  return withKeys({ clientId: a[2].clientId }, () => describePhoto__(...a));
}
