"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channels, clients, contentItems } from "@/db/schema";
import { defaultImagePrompt, generateContentImage, removeContentImage } from "@/lib/content/images";
import { CONTENT_KINDS, CONTENT_PLATFORMS } from "@/lib/content/kinds";
import { requireUser } from "@/lib/auth";
import { withKeys } from "@/lib/keys";
import { generateContent, publishItem } from "@/lib/content/studio";

const genSchema = z.object({
  kind: z.enum(CONTENT_KINDS),
  platform: z.enum(CONTENT_PLATFORMS),
  brief: z.string().trim().min(3).max(20_000),
  tone: z.string().trim().max(200),
  length: z.enum(["short", "medium", "long"]),
  variants: z.number().int().min(1).max(10),
  platforms: z.array(z.enum(CONTENT_PLATFORMS)).max(7).optional(),
  useKb: z.boolean(),
  /** Сразу нарисовать картинку к каждому варианту (OpenAI) */
  withImage: z.boolean().optional(),
});

async function generateContentAction__(clientId: string, input: z.input<typeof genSchema>): Promise<{ error?: string; batch?: string; imageError?: string }> {
  await requireUser();
  const parsed = genSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  try {
    const { withImage, ...gen } = parsed.data;
    const rows = await generateContent(clientId, gen);
    // Картинки — к каждому варианту параллельно; не вышло — тексты остаются, картинку можно добавить потом
    let imageError: string | undefined;
    if (withImage && rows.length) {
      const [c] = await db.select({ name: clients.name, industry: clients.industry }).from(clients).where(eq(clients.id, clientId));
      const results = await Promise.allSettled(
        rows.map(async (r) => {
          const prompt = defaultImagePrompt({ title: r.title, brief: r.brief, client: c?.name ?? "", industry: c?.industry ?? "" });
          const name = await generateContentImage(prompt);
          await db.update(contentItems).set({ image: name, imagePrompt: prompt, updatedAt: new Date() }).where(eq(contentItems.id, r.id));
        }),
      );
      const failed = results.find((x): x is PromiseRejectedResult => x.status === "rejected");
      if (failed) {
        const m = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
        if (m !== "no_openai") console.error("content image failed", m);
        imageError = m === "no_openai" ? m : "image_failed";
      }
    }
    refresh();
    return { batch: rows[0]?.batch, imageError };
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m !== "no_key" && m !== "empty") console.error("content generate failed", e);
    return { error: m === "no_key" || m === "empty" ? m : "failed" };
  }
}

const saveSchema = z.object({
  title: z.string().trim().max(300),
  text: z.string().trim().min(1).max(20_000),
  channelId: z.string().nullable(),
  target: z.string().trim().max(200),
});

/** Правка текста и куда публиковать. */
export async function saveContentItem(clientId: string, id: string, input: z.input<typeof saveSchema>): Promise<{ error?: string }> {
  await requireUser();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (d.channelId) {
    const [ch] = await db.select({ type: channels.type }).from(channels).where(and(eq(channels.id, d.channelId), eq(channels.clientId, clientId)));
    if (ch?.type !== "telegram" && ch?.type !== "threads") return { error: "invalid" };
  }
  await db
    .update(contentItems)
    .set({ ...d, updatedAt: new Date() })
    .where(and(eq(contentItems.id, id), eq(contentItems.clientId, clientId)));
  refresh();
  return {};
}

/** Опубликовать сейчас (at = null) или по расписанию; отменить расписание — cancel. */
export async function scheduleContent(clientId: string, id: string, at: number | null): Promise<{ error?: string; url?: string }> {
  await requireUser();
  const [item] = await db.select().from(contentItems).where(and(eq(contentItems.id, id), eq(contentItems.clientId, clientId)));
  if (!item) return { error: "not_found" };
  if (!item.channelId) return { error: "no_target" };
  const [ch] = await db.select({ type: channels.type }).from(channels).where(eq(channels.id, item.channelId));
  if (ch?.type === "telegram" && !item.target.trim()) return { error: "no_target" };
  if (at == null) {
    const r = await publishItem(id);
    refresh();
    return r.ok ? { url: r.url } : { error: r.error };
  }
  if (!Number.isFinite(at) || at < Date.now() - 60_000) return { error: "past" };
  await db.update(contentItems).set({ status: "scheduled", publishAt: new Date(at), error: null, updatedAt: new Date() }).where(eq(contentItems.id, id));
  refresh();
  return {};
}

export async function unscheduleContent(id: string) {
  await requireUser();
  await db.update(contentItems).set({ status: "draft", publishAt: null, updatedAt: new Date() }).where(and(eq(contentItems.id, id), eq(contentItems.status, "scheduled")));
  refresh();
}

export async function deleteContentItem(id: string) {
  await requireUser();
  const [row] = await db.delete(contentItems).where(eq(contentItems.id, id)).returning({ image: contentItems.image });
  if (row?.image) removeContentImage(row.image);
  refresh();
}

/** Сгенерировать картинку к посту (заменяет прежнюю). Пустая подсказка — по теме поста. */
async function generateImageAction__(clientId: string, id: string, prompt: string): Promise<{ error?: string }> {
  await requireUser();
  const [row] = await db
    .select({ item: contentItems, client: clients.name, industry: clients.industry })
    .from(contentItems)
    .innerJoin(clients, eq(clients.id, contentItems.clientId))
    .where(and(eq(contentItems.id, id), eq(contentItems.clientId, clientId)));
  if (!row) return { error: "not_found" };
  const text = prompt.trim().slice(0, 4000) || defaultImagePrompt({ title: row.item.title, brief: row.item.brief, client: row.client, industry: row.industry });
  try {
    const name = await generateContentImage(text);
    if (row.item.image) removeContentImage(row.item.image);
    await db.update(contentItems).set({ image: name, imagePrompt: text, updatedAt: new Date() }).where(eq(contentItems.id, id));
    refresh();
    return {};
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m !== "no_openai") console.error("image generation failed", m);
    return { error: m === "no_openai" ? m : "image_failed" };
  }
}

export async function removeImageAction(id: string) {
  await requireUser();
  const [row] = await db.select({ image: contentItems.image }).from(contentItems).where(eq(contentItems.id, id));
  if (row?.image) removeContentImage(row.image);
  await db.update(contentItems).set({ image: "", updatedAt: new Date() }).where(eq(contentItems.id, id));
  refresh();
}

export async function generateContentAction(...a: Parameters<typeof generateContentAction__>): ReturnType<typeof generateContentAction__> {
  return withKeys({ clientId: a[0] }, () => generateContentAction__(...a));
}

export async function generateImageAction(...a: Parameters<typeof generateImageAction__>): ReturnType<typeof generateImageAction__> {
  return withKeys({ clientId: a[0] }, () => generateImageAction__(...a));
}
