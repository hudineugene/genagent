/**
 * Документы базы знаний из Markdown-файлов → payload для deploy/seeds/upsert-sources.mjs (на сервере).
 * Нарезка на фрагменты — та же, что в программе (chunkText), поэтому поиск работает как для документов из студии.
 * npx tsx scripts/build-kb-payload.ts "<имя клиента>" <файл1.md> [<файл2.md> …] > payload.json
 * Заголовок документа — первая строка файла «# …».
 */
import { readFileSync } from "node:fs";
import { chunkText, normalizeText } from "@/lib/kb/text";

(async () => {
  const [clientName, ...files] = process.argv.slice(2);
  if (!clientName || !files.length) throw new Error("Укажите имя клиента и файлы");
  const sources = files.map((file) => {
    const raw = readFileSync(file, "utf8");
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (!title) throw new Error(`${file}: нет заголовка «# …» в первой строке`);
    const content = normalizeText(raw);
    return { title, content, chunks: chunkText(content, title) };
  });
  process.stdout.write(JSON.stringify({ clientName, sources }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
