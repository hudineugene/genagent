// Добавить или обновить документы базы знаний клиента «как из студии» (без ключа своего бота —
// синхронизация бота их не трогает). Документ с тем же названием у клиента обновляется.
// Использование (в контейнере): node upsert-sources.mjs <путь к базе> < payload.json
// payload: { clientName, sources: [{ title, content, chunks: string[] }] } — готовит scripts/build-kb-payload.ts.
// «Отпечатки» для смыслового поиска досчитаются в фоне при следующем запуске программы; поиск по словам работает сразу.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Укажите путь к базе");
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const p = JSON.parse(raw);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
const client = db.prepare("SELECT id FROM clients WHERE name = ?").get(p.clientName);
if (!client) throw new Error("Клиент не найден: " + p.clientName);
const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
const now = Date.now();
const result = [];

db.exec("BEGIN");
try {
  const insChunk = db.prepare("INSERT INTO kb_chunks (id, source_id, client_id, idx, text) VALUES (?, ?, ?, ?, ?)");
  const insFts = db.prepare("INSERT INTO kb_chunks_fts (text, chunk_id, source_id, client_id) VALUES (?, ?, ?, ?)");
  for (const s of p.sources) {
    let source = db.prepare("SELECT id FROM kb_sources WHERE client_id = ? AND title = ? AND external_key IS NULL").get(client.id, s.title);
    if (source) {
      db.prepare("DELETE FROM kb_chunks_fts WHERE source_id = ?").run(source.id);
      db.prepare("DELETE FROM kb_chunks WHERE source_id = ?").run(source.id);
      db.prepare("UPDATE kb_sources SET content = ?, chars = ?, chunks = ?, status = 'ready', error = NULL, updated_at = ? WHERE id = ?").run(
        s.content, s.content.length, s.chunks.length, now, source.id,
      );
      result.push({ title: s.title, action: "updated", chunks: s.chunks.length });
    } else {
      source = { id: randomUUID() };
      db.prepare(
        "INSERT INTO kb_sources (id, client_id, type, title, status, content, chars, chunks, pages, created_by, created_at, updated_at, external_key) VALUES (?, ?, 'text', ?, 'ready', ?, ?, ?, 0, ?, ?, ?, NULL)",
      ).run(source.id, client.id, s.title, s.content, s.content.length, s.chunks.length, admin?.id ?? null, now, now);
      result.push({ title: s.title, action: "created", chunks: s.chunks.length });
    }
    s.chunks.forEach((text, idx) => {
      const cid = randomUUID();
      insChunk.run(cid, source.id, client.id, idx, text);
      insFts.run(text, cid, source.id, client.id);
    });
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(JSON.stringify(result));
