// Импорт клиента, базы знаний и агента из payload (см. studio-yabot.ts) в базу GenAgent.
// Использование: node import.mjs <путь к базе> < payload.json
// Клиент с таким именем уже есть — ничего не делает. Агент создаётся черновиком (версия 1).
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("Укажите путь к базе");
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const p = JSON.parse(raw);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
const exists = db.prepare("SELECT id FROM clients WHERE name = ?").get(p.client.name);
if (exists) {
  console.log("Клиент уже есть:", exists.id);
  process.exit(0);
}

const now = Date.now();
const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
const clientId = randomUUID();
const agentId = randomUUID();

db.exec("BEGIN");
try {
  const c = p.client;
  db.prepare(
    "INSERT INTO clients (id, name, industry, website, description, brand_voice, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(clientId, c.name, c.industry, c.website, c.description, c.brandVoice, c.color, now);

  const insSource = db.prepare(
    "INSERT INTO kb_sources (id, client_id, type, title, status, content, chars, chunks, pages, created_by, created_at, updated_at, external_key) VALUES (?, ?, 'text', ?, 'ready', ?, ?, ?, 0, ?, ?, ?, ?)",
  );
  const insChunk = db.prepare("INSERT INTO kb_chunks (id, source_id, client_id, idx, text) VALUES (?, ?, ?, ?, ?)");
  const insFts = db.prepare("INSERT INTO kb_chunks_fts (text, chunk_id, source_id, client_id) VALUES (?, ?, ?, ?)");
  p.sources.forEach((s, i) => {
    const sid = randomUUID();
    // Разное время создания — стабильный порядок источников в списке.
    // key — документ, который потом будет обновлять свой бот клиента (синхронизация базы знаний).
    insSource.run(sid, clientId, s.title, s.content, s.content.length, s.chunks.length, admin?.id ?? null, now + i, now + i, s.key ?? null);
    s.chunks.forEach((text, idx) => {
      const cid = randomUUID();
      insChunk.run(cid, sid, clientId, idx, text);
      insFts.run(text, cid, sid, clientId);
    });
  });

  const config = JSON.stringify(p.agent.config);
  db.prepare(
    "INSERT INTO agents (id, client_id, name, status, version, config, template_key, created_at, updated_at) VALUES (?, ?, ?, 'draft', 1, ?, NULL, ?, ?)",
  ).run(agentId, clientId, p.agent.name, config, now, now);
  db.prepare(
    "INSERT INTO agent_versions (id, agent_id, version, name, config, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)",
  ).run(randomUUID(), agentId, p.agent.name, config, admin?.id ?? null, now);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(JSON.stringify({ clientId, agentId }));
