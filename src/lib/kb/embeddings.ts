import "server-only";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "@/db";

/**
 * Смысловой поиск: локальная многоязычная модель multilingual-e5-small (русский, украинский, английский и др.)
 * через transformers.js. Работает на сервере без внешних ключей; модель (~120 МБ) скачивается один раз в MODELS_DIR.
 *
 * Библиотека с движком ONNX (~450 МБ) не входит в сборку: на сервере она стоит в отдельной папке (vendor, NODE_PATH).
 * Если она недоступна (например, локально на Windows) — поиск работает как раньше, по словам.
 */
const MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIMS = 384;
const BATCH = 16;

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

const g = globalThis as unknown as {
  __embedder?: Promise<Extractor | null>;
  __embedState?: { status: "off" | "loading" | "ready" | "unavailable"; error?: string };
  __embedWorker?: boolean;
};

export function embeddingStatus() {
  return g.__embedState ?? { status: process.env.EMBEDDINGS === "off" ? "off" : "loading" };
}

function load(): Promise<Extractor | null> {
  if (process.env.EMBEDDINGS === "off") {
    g.__embedState = { status: "off" };
    return Promise.resolve(null);
  }
  return (g.__embedder ??= (async () => {
    g.__embedState = { status: "loading" };
    try {
      // Где лежит библиотека: на сервере — VENDOR_DIR (отдельная папка), локально — зависимости проекта.
      // Имя модуля в переменной — чтобы сборщик не пытался положить библиотеку в бандл.
      const mod = "@huggingface/transformers";
      const req = createRequire(path.join(process.cwd(), "noop.js"));
      const entry = req.resolve(mod, { paths: [process.env.VENDOR_DIR, process.cwd()].filter((p): p is string => !!p) });
      const tf = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(entry).href)) as {
        pipeline: (task: string, model: string, opts: object) => Promise<Extractor>;
        env: { cacheDir: string; allowRemoteModels: boolean };
      };
      tf.env.cacheDir = process.env.MODELS_DIR ?? "./data/models";
      const extractor = await tf.pipeline("feature-extraction", MODEL, { dtype: "q8" });
      g.__embedState = { status: "ready" };
      return extractor;
    } catch (e) {
      g.__embedState = { status: "unavailable", error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      console.warn("semantic search unavailable:", g.__embedState.error);
      return null;
    }
  })());
}

async function embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[] | null> {
  const extractor = await load();
  if (!extractor) return null;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // e5 требует префиксы «query:» и «passage:» — так модель различает вопрос и текст базы знаний.
    const batch = texts.slice(i, i + BATCH).map((t) => `${kind}: ${t.slice(0, 2000)}`);
    const r = await extractor(batch, { pooling: "mean", normalize: true });
    const dims = r.dims[1];
    for (let j = 0; j < batch.length; j++) out.push(r.data.slice(j * dims, (j + 1) * dims));
  }
  return out;
}

export async function embedQuery(text: string) {
  return (await embed([text], "query"))?.[0] ?? null;
}

export function toBuffer(v: Float32Array) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBuffer(b: Uint8Array) {
  const copy = new Uint8Array(b); // выравнивание для Float32Array
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Векторы нормализованы — скалярное произведение равно косинусной близости. */
export function cosine(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Фоновый расчёт «отпечатков» для фрагментов, у которых их ещё нет (новые источники и старые после обновления).
 * Один обработчик на процесс; запускается при старте и после каждой индексации.
 */
export function kickEmbeddingWorker() {
  if (g.__embedWorker || process.env.EMBEDDINGS === "off") return;
  g.__embedWorker = true;
  void (async () => {
    try {
      for (;;) {
        const rows = db.$sqlite
          .prepare("SELECT id, text FROM kb_chunks WHERE embedding IS NULL LIMIT 64")
          .all() as { id: string; text: string }[];
        if (!rows.length) break;
        const vectors = await embed(
          rows.map((r) => r.text),
          "passage",
        );
        if (!vectors) break; // модель недоступна — остаётся поиск по словам
        const upd = db.$sqlite.prepare("UPDATE kb_chunks SET embedding = ? WHERE id = ?");
        db.$sqlite.exec("BEGIN");
        try {
          rows.forEach((r, i) => upd.run(toBuffer(vectors[i]), r.id));
          db.$sqlite.exec("COMMIT");
        } catch (e) {
          db.$sqlite.exec("ROLLBACK");
          throw e;
        }
        // Отдаём процессор ответам клиентам между пачками.
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (e) {
      console.error("embedding worker failed", e);
    } finally {
      g.__embedWorker = false;
    }
  })();
}

/** Сколько фрагментов клиента уже с «отпечатками» — для отображения в базе знаний. */
export function embeddingProgress(clientId: string) {
  const r = db.$sqlite
    .prepare("SELECT count(*) AS total, sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS done FROM kb_chunks WHERE client_id = ?")
    .get(clientId) as { total: number; done: number | null };
  return { total: Number(r.total), done: Number(r.done ?? 0) };
}
