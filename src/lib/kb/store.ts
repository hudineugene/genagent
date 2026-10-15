import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { kbSources } from "@/db/schema";
import { FULL_CONTEXT_MAX_CHARS, buildFtsQuery, chunkText, estimateTokens } from "./text";
import { cosine, embedQuery, fromBuffer, kickEmbeddingWorker } from "./embeddings";
import { crawl, pagesToDocument } from "./crawl";

/** Сколько фрагментов подмешивать к сообщению в режиме поиска. */
const SEARCH_TOP_K = 8;
const MAX_SOURCE_CHARS = 2_000_000;

/** Пересобирает фрагменты и полнотекстовый индекс источника. */
export function indexSource(sourceId: string, clientId: string, title: string, text: string) {
  const content = text.slice(0, MAX_SOURCE_CHARS);
  const chunks = chunkText(content, title);
  const sqlite = db.$sqlite;
  sqlite.exec("BEGIN");
  try {
    removeIndexRaw(sourceId);
    const insChunk = sqlite.prepare("INSERT INTO kb_chunks (id, source_id, client_id, idx, text) VALUES (?, ?, ?, ?, ?)");
    const insFts = sqlite.prepare("INSERT INTO kb_chunks_fts (text, chunk_id, source_id, client_id) VALUES (?, ?, ?, ?)");
    chunks.forEach((c, i) => {
      const id = crypto.randomUUID();
      insChunk.run(id, sourceId, clientId, i, c);
      insFts.run(c, id, sourceId, clientId);
    });
    sqlite
      .prepare(
        "UPDATE kb_sources SET content = ?, chars = ?, chunks = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(content, content.length, chunks.length, Date.now(), sourceId);
    sqlite.exec("COMMIT");
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
  kickEmbeddingWorker(); // «отпечатки» для смыслового поиска считаются в фоне
  return { chunks: chunks.length, chars: content.length };
}

function removeIndexRaw(sourceId: string) {
  db.$sqlite.prepare("DELETE FROM kb_chunks_fts WHERE source_id = ?").run(sourceId);
  db.$sqlite.prepare("DELETE FROM kb_chunks WHERE source_id = ?").run(sourceId);
}

/** Удаляет записи полнотекстового индекса (обычные таблицы чистятся каскадом). */
export function removeIndexForSource(sourceId: string) {
  removeIndexRaw(sourceId);
}
export function removeIndexForClient(clientId: string) {
  db.$sqlite.prepare("DELETE FROM kb_chunks_fts WHERE client_id = ?").run(clientId);
}

// ---------- фоновая загрузка сайтов ----------

const running = new Set<string>();

export async function setSourceError(sourceId: string, error: string) {
  await db
    .update(kbSources)
    .set({ status: "error", error, updatedAt: new Date() })
    .where(eq(kbSources.id, sourceId));
}

/** Обходит сайт в фоне (не блокируя запрос) и индексирует результат. */
export function startCrawl(sourceId: string) {
  if (running.has(sourceId)) return;
  running.add(sourceId);
  void (async () => {
    try {
      const [s] = await db.select().from(kbSources).where(eq(kbSources.id, sourceId));
      if (!s?.url) return;
      const pages = await crawl(s.url, s.crawl ?? "page", {
        limit: 30,
        onProgress: (n) => {
          db.$sqlite.prepare("UPDATE kb_sources SET pages = ? WHERE id = ?").run(n, sourceId);
        },
      });
      const title = s.crawl === "page" && pages[0]?.title ? pages[0].title : s.title;
      await db.update(kbSources).set({ title, pages: pages.length }).where(eq(kbSources.id, sourceId));
      indexSource(sourceId, s.clientId, title, pagesToDocument(pages));
    } catch (e) {
      console.error("crawl failed", sourceId, e);
      await setSourceError(sourceId, e instanceof Error ? e.message : String(e)).catch(() => {});
    } finally {
      running.delete(sourceId);
    }
  })();
}

/** После перезапуска сервера незавершённые загрузки помечаем ошибкой — их можно обновить вручную. */
export async function markInterrupted() {
  await db
    .update(kbSources)
    .set({ status: "error", error: "interrupted" })
    .where(eq(kbSources.status, "processing"));
}

// ---------- знания для ответа агента ----------

export type KnowledgeSourceRef = { id: string; title: string; url: string | null };

export type Knowledge =
  | { mode: "none" }
  | { mode: "full"; docs: { title: string; content: string }[]; sources: KnowledgeSourceRef[] }
  | { mode: "search"; context: string | null; sources: KnowledgeSourceRef[]; used: KnowledgeSourceRef[] };

async function readySources(clientId: string, sourceIds: string[] | null | undefined) {
  const where = [eq(kbSources.clientId, clientId), eq(kbSources.status, "ready")];
  if (sourceIds) {
    if (!sourceIds.length) return [];
    where.push(inArray(kbSources.id, sourceIds));
  }
  return db
    .select({ id: kbSources.id, title: kbSources.title, url: kbSources.url, chars: kbSources.chars })
    .from(kbSources)
    .where(and(...where));
}

/** Сводка для конструктора: сколько источников, объём и какой режим будет использован. */
export async function knowledgeSummary(clientId: string, sourceIds: string[] | null | undefined) {
  const sources = await readySources(clientId, sourceIds);
  const chars = sources.reduce((n, s) => n + s.chars, 0);
  return {
    sources: sources.length,
    tokens: estimateTokens(chars),
    mode: sources.length === 0 ? "none" : chars <= FULL_CONTEXT_MAX_CHARS ? "full" : "search",
  } as const;
}

/**
 * Готовит знания для ответа: небольшая база целиком (в системный промпт),
 * большая — топ фрагментов по последним сообщениям клиента (к последнему сообщению).
 */
export async function loadKnowledge(
  clientId: string,
  sourceIds: string[] | null | undefined,
  userMessages: string[],
): Promise<Knowledge> {
  const sources = await readySources(clientId, sourceIds);
  if (!sources.length) return { mode: "none" };
  const refs = sources.map(({ id, title, url }) => ({ id, title, url }));
  const total = sources.reduce((n, s) => n + s.chars, 0);

  if (total <= FULL_CONTEXT_MAX_CHARS) {
    const rows = await db
      .select({ id: kbSources.id, title: kbSources.title, content: kbSources.content })
      .from(kbSources)
      .where(inArray(kbSources.id, refs.map((r) => r.id)));
    // Стабильный порядок — для кэширования промпта.
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return { mode: "full", docs: rows.map(({ title, content }) => ({ title, content })), sources: refs };
  }

  // Ищем по последнему сообщению, а если по нему ничего — по двум последним вместе.
  const last = userMessages.at(-1) ?? "";
  // Короткие уточнения («а для детей?») ищем вместе с предыдущим вопросом — так понятнее, о чём речь.
  const prev = userMessages.at(-2);
  const query = last.length < 40 && prev ? `${prev}\n${last}` : last;
  let hits = await search(clientId, refs, query);
  if (!hits.length && userMessages.length > 1) hits = await search(clientId, refs, userMessages.slice(-2).join(" "));
  if (!hits.length) return { mode: "search", context: null, sources: refs, used: [] };

  const byId = new Map(refs.map((r) => [r.id, r]));
  const used = [...new Set(hits.map((h) => h.sourceId))].map((id) => byId.get(id)!).filter(Boolean);
  const context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n");
  return { mode: "search", context, sources: refs, used };
}

type Hit = { id: string; text: string; sourceId: string };

/** Поиск по словам (FTS5, BM25). */
function keywordSearch(clientId: string, refs: KnowledgeSourceRef[], text: string, limit: number): Hit[] {
  const query = buildFtsQuery(text);
  if (!query) return [];
  const placeholders = refs.map(() => "?").join(",");
  try {
    return db.$sqlite
      .prepare(
        `SELECT chunk_id AS id, text, source_id AS sourceId FROM kb_chunks_fts
         WHERE kb_chunks_fts MATCH ? AND client_id = ? AND source_id IN (${placeholders})
         ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
      )
      .all(query, clientId, ...refs.map((r) => r.id), limit) as Hit[];
  } catch (e) {
    console.error("kb keyword search failed", query, e);
    return [];
  }
}

/** Поиск по смыслу: близость «отпечатков» вопроса и фрагментов. null — смысловой поиск недоступен. */
async function semanticSearch(clientId: string, refs: KnowledgeSourceRef[], text: string, limit: number) {
  const q = await embedQuery(text);
  if (!q) return null;
  const placeholders = refs.map(() => "?").join(",");
  const rows = db.$sqlite
    .prepare(
      `SELECT id, text, source_id AS sourceId, embedding FROM kb_chunks
       WHERE client_id = ? AND source_id IN (${placeholders}) AND embedding IS NOT NULL`,
    )
    .all(clientId, ...refs.map((r) => r.id)) as (Hit & { embedding: Uint8Array })[];
  return rows
    .map((r) => ({ id: r.id, text: r.text, sourceId: r.sourceId, score: cosine(q, fromBuffer(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Гибридный поиск: результаты по словам и по смыслу объединяются методом Reciprocal Rank Fusion —
 * точные совпадения (названия, цены, артикулы) не теряются, а вопросы «своими словами» тоже находят ответ.
 */
async function search(clientId: string, refs: KnowledgeSourceRef[], text: string): Promise<Hit[]> {
  const keyword = keywordSearch(clientId, refs, text, 20);
  const semantic = await semanticSearch(clientId, refs, text, 20).catch((e) => {
    console.error("kb semantic search failed", e);
    return null;
  });
  if (!semantic) return keyword.slice(0, SEARCH_TOP_K);

  const K = 60;
  const fused = new Map<string, { hit: Hit; score: number }>();
  const add = (list: Hit[]) =>
    list.forEach((h, rank) => {
      const cur = fused.get(h.id) ?? { hit: h, score: 0 };
      cur.score += 1 / (K + rank + 1);
      fused.set(h.id, cur);
    });
  add(keyword);
  add(semantic);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_TOP_K)
    .map((x) => x.hit);
}
