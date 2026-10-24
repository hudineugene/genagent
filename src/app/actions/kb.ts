"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { kbSources } from "@/db/schema";
import { normalizeText } from "@/lib/kb/text";
import { indexSource, removeIndexForSource, startCrawl } from "@/lib/kb/store";

import { requireClient, requireOwned } from "@/lib/access";
export type KbResult = { error?: string; id?: string };

const urlSchema = z.object({
  url: z
    .string()
    .trim()
    .transform((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
    .pipe(z.string().url()),
  crawl: z.enum(["page", "site"]),
});

export async function addUrlSource(clientId: string, _prev: KbResult | undefined, formData: FormData): Promise<KbResult> {
  const user = await requireClient(clientId);
  const parsed = urlSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "bad_url" };
  const { url, crawl } = parsed.data;
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  // Пока страница не скачана — временное имя; для одной страницы потом подставится её заголовок.
  const title = crawl === "site" ? host : host + u.pathname.replace(/\/$/, "");
  const [s] = await db
    .insert(kbSources)
    .values({ clientId, type: "url", title, url, crawl, createdBy: user.id })
    .returning({ id: kbSources.id });
  startCrawl(s.id);
  refresh();
  return { id: s.id };
}

const textSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().max(2_000_000),
});

export async function addTextSource(clientId: string, _prev: KbResult | undefined, formData: FormData): Promise<KbResult> {
  const user = await requireClient(clientId);
  const parsed = textSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid" };
  const content = normalizeText(parsed.data.content);
  if (!content) return { error: "empty" };
  const [s] = await db
    .insert(kbSources)
    .values({ clientId, type: "text", title: parsed.data.title, createdBy: user.id })
    .returning({ id: kbSources.id });
  indexSource(s.id, clientId, parsed.data.title, content);
  refresh();
  return { id: s.id };
}

export async function updateTextSource(id: string, _prev: KbResult | undefined, formData: FormData): Promise<KbResult> {
  await requireOwned("kbSource", id);
  const parsed = textSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid" };
  const [s] = await db.select().from(kbSources).where(eq(kbSources.id, id));
  if (!s || s.type !== "text") return { error: "not_found" };
  const content = normalizeText(parsed.data.content);
  if (!content) return { error: "empty" };
  await db.update(kbSources).set({ title: parsed.data.title }).where(eq(kbSources.id, id));
  indexSource(id, s.clientId, parsed.data.title, content);
  refresh();
  return { id };
}

/** Сайт — скачать заново; файл и текст — переиндексировать сохранённый текст. */
export async function refreshSource(id: string): Promise<KbResult> {
  await requireOwned("kbSource", id);
  const [s] = await db.select().from(kbSources).where(eq(kbSources.id, id));
  if (!s) return { error: "not_found" };
  if (s.type === "url") {
    await db.update(kbSources).set({ status: "processing", error: null, pages: 0 }).where(eq(kbSources.id, id));
    startCrawl(id);
  } else if (s.content) {
    indexSource(id, s.clientId, s.title, s.content);
  }
  refresh();
  return { id };
}

export async function deleteSource(id: string): Promise<KbResult> {
  await requireOwned("kbSource", id);
  removeIndexForSource(id);
  await db.delete(kbSources).where(eq(kbSources.id, id));
  refresh();
  return {};
}
