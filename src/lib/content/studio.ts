import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { channels, clients, contentItems, type ContentItem, type TelegramConfig, type ThreadsConfig } from "@/db/schema";
import { loadKnowledge } from "@/lib/kb/store";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";
import { callTelegram, sendPhoto } from "@/lib/channels/telegram-api";
import { publishPost } from "@/lib/channels/meta/threads";
import { toPlainText } from "@/lib/conversations";
import { publicUrl } from "@/lib/settings";
import { readContentImage } from "./images";
import { toTelegramHtml } from "@/lib/routines/engine";

/**
 * Контент-студия: генерация текстов в стиле бренда по данным клиента (профиль, голос бренда, база знаний)
 * и публикация в Telegram-канал через бота клиента — сразу или по расписанию.
 */
const MODEL = "claude-sonnet-5-5";
const KB_CHARS = 30_000;

export type ContentKind = ContentItem["kind"];
export type ContentPlatform = ContentItem["platform"];
export type GenerateInput = { kind: ContentKind; platform: ContentPlatform; brief: string; tone: string; length: "short" | "medium" | "long"; variants: number; useKb: boolean };

const KIND_RULES: Record<ContentKind, string> = {
  post: "Пост для соцсети: цепляющая первая строка, польза или история, призыв к действию в конце.",
  article: "Статья для блога: заголовок, вступление, 3–6 разделов с подзаголовками (##), вывод с призывом к действию.",
  ad: "Рекламное объявление: короткий заголовок (до 40 знаков) в title и текст (до 125 знаков для соцсетей, до 90 для поиска). Варианты должны отличаться подходом (выгода, боль, социальное доказательство, срочность) — для A/B-теста.",
  seo: "SEO-бриф для копирайтера: цель страницы, основной и дополнительные ключевые запросы, интент, title и meta description, структура H1–H3 с тезисами, что обязательно упомянуть, внутренние ссылки, объём.",
  vacancy: "Вакансия: должность в title, о компании (2–3 предложения), задачи, требования, условия (только известные), как откликнуться.",
};
const PLATFORM_RULES: Record<ContentPlatform, string> = {
  telegram: "Telegram-канал: абзацы по 1–3 строки, можно эмодзи в меру, жирный — **так**, без хэштегов или 1–2 в конце.",
  instagram: "Instagram: первая строка — крючок, короткие абзацы, эмодзи, 5–10 релевантных хэштегов в конце.",
  facebook: "Facebook: дружелюбно, абзацы, вопрос к аудитории в конце, 0–3 хэштега.",
  linkedin: "LinkedIn: деловой тон, экспертиза и цифры, короткие абзацы, 3–5 хэштегов в конце.",
  threads: "Threads: до 500 знаков, разговорно, без хэштегов или один.",
  site: "Сайт: структурировано, с подзаголовками, без эмодзи.",
  email: "Email-рассылка: тема письма в title, приветствие, суть, одна кнопка-призыв (текстом), подпись.",
};
const LENGTH: Record<GenerateInput["length"], string> = { short: "коротко (до 600 знаков)", medium: "средне (600–1500 знаков)", long: "развёрнуто (1500–4000 знаков)" };

export async function generateContent(clientId: string, input: GenerateInput) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("no_key");
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new Error("not_found");
  let facts = "";
  if (input.useKb) {
    const kb = await loadKnowledge(clientId, null, [input.brief]).catch(() => ({ mode: "none" as const }));
    if (kb.mode === "full") facts = kb.docs.map((d) => `## ${d.title}\n${d.content}`).join("\n\n");
    else if (kb.mode === "search") facts = [...(kb.pinned ?? []).map((d) => `## ${d.title}\n${d.content}`), kb.context ?? ""].join("\n\n");
  }
  const variants = Math.min(3, Math.max(1, input.variants));
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ variants: { title: string; text: string }[] }>(apiKey, MODEL, {
    system: [
      `Ты копирайтер компании «${client.name}»${client.industry ? ` (${client.industry})` : ""}${client.website ? `, сайт ${client.website}` : ""}.`,
      client.description ? `О компании: ${client.description}` : "",
      client.brandVoice ? `Голос бренда: ${client.brandVoice}` : "",
      `Задача: ${KIND_RULES[input.kind]}`,
      `Площадка: ${PLATFORM_RULES[input.platform]}`,
      `Объём: ${input.kind === "ad" ? "по правилам объявления" : LENGTH[input.length]}.`,
      input.tone ? `Тон: ${input.tone}.` : "",
      "Факты (цены, сроки, характеристики, адреса) бери только из данных компании ниже или из задания. Чего нет — не выдумывай: пиши без конкретики или поставь [уточнить]. Язык — язык задания.",
      `Сделай ${variants} ${variants === 1 ? "вариант" : "разных варианта"}. title — заголовок или тема (для поста — короткая тема для списка), text — готовый текст.`,
      facts ? `\nДанные компании:\n${facts.slice(0, KB_CHARS)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: `Задание: ${input.brief}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["variants"],
      properties: {
        variants: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } } },
      },
    },
    effort: "medium",
  });
  await logUsage({ source: "generate", model, usage, clientId, ms: Date.now() - started }).catch(() => {});
  const batch = randomUUID();
  const rows = data.variants.slice(0, variants).filter((v) => v.text.trim());
  if (!rows.length) throw new Error("empty");
  return db
    .insert(contentItems)
    .values(rows.map((v) => ({ clientId, batch, kind: input.kind, platform: input.platform, brief: input.brief.slice(0, 2000), title: v.title.trim().slice(0, 300), text: v.text.trim().slice(0, 20_000) })))
    .returning();
}

/** Опубликовать в Telegram-канал от имени бота клиента. Бот должен быть администратором канала. */
/** Telegram: подпись к фото — до 1024 знаков, текстом — до 4096; Threads — до 500. */
const CAPTION_LIMIT = 1024;
const THREADS_LIMIT = 500;

/**
 * Опубликовать: в Telegram-канал от имени бота клиента (бот — администратор канала) или в Threads от имени
 * подключённого аккаунта. С картинкой: в Telegram — фото с подписью (длинный текст — следом отдельным сообщением),
 * в Threads — по публичной ссылке /m/<имя>.
 */
export async function publishItem(id: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id));
  if (!item) return { ok: false, error: "not_found" };
  const fail = async (error: string) => {
    await db.update(contentItems).set({ status: "failed", error: error.slice(0, 500), updatedAt: new Date() }).where(eq(contentItems.id, id));
    return { ok: false, error };
  };
  if (!item.channelId) return fail("no_target");
  const [ch] = await db.select().from(channels).where(and(eq(channels.id, item.channelId), eq(channels.clientId, item.clientId)));
  if (!ch || (ch.type !== "telegram" && ch.type !== "threads")) return fail("no_target");
  const done = async (url: string) => {
    await db.update(contentItems).set({ status: "published", publishedAt: new Date(), url, error: null, updatedAt: new Date() }).where(eq(contentItems.id, id));
    return { ok: true, url };
  };
  try {
    if (ch.type === "threads") {
      const text = toPlainText(item.text);
      if (text.length > THREADS_LIMIT) return fail("too_long_threads");
      let imageUrl: string | undefined;
      if (item.image) {
        const base = publicUrl();
        if (!base) return fail("no_public_url");
        imageUrl = `${base}/m/${item.image}`;
      }
      const r = await publishPost((ch.config as ThreadsConfig).token, text, imageUrl);
      return done(r.permalink);
    }
    if (!item.target.trim()) return fail("no_target");
    const token = (ch.config as TelegramConfig).token;
    const html = toTelegramHtml(item.text);
    if (html.length > 4096) return fail("too_long");
    const img = item.image ? readContentImage(item.image) : null;
    if (item.image && !img) return fail("image_missing");
    let r: { message_id: number; chat: { username?: string } };
    if (img) {
      const fits = html.length <= CAPTION_LIMIT;
      r = await sendPhoto(token, item.target.trim(), { ...img, name: item.image }, fits ? html : undefined);
      if (!fits) await callTelegram(token, "sendMessage", { chat_id: item.target.trim(), text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } else {
      r = await callTelegram(token, "sendMessage", { chat_id: item.target.trim(), text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    }
    return done(r.chat.username ? `https://t.me/${r.chat.username}/${r.message_id}` : "");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Публикации, время которых пришло. */
export async function publishDue() {
  const due = await db
    .select({ id: contentItems.id })
    .from(contentItems)
    .where(and(eq(contentItems.status, "scheduled"), lte(contentItems.publishAt, new Date())))
    .limit(20);
  for (const d of due) await publishItem(d.id).catch((e) => console.error("content publish failed", d.id, e));
}

const g = globalThis as unknown as { __contentTimer?: NodeJS.Timeout };
export function startContent() {
  if (g.__contentTimer) return;
  g.__contentTimer = setInterval(() => void publishDue().catch((e) => console.error("content tick failed", e)), 60_000);
  g.__contentTimer.unref?.();
}
