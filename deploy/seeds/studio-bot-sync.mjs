// Разовая настройка для синхронизации с ботом заказов студии (@yabotuabot, src/genagent.js):
// документы «Послуги та ціни» и «Часті питання» получают ключи services/faq — дальше их перезаписывает бот;
// из фактов агента убираются цены и график (теперь они в базе знаний), сохраняется новой версией.
// Использование: node studio-bot-sync.mjs <путь к базе> (в контейнере путь берётся из DB_PATH). Повторный запуск ничего не меняет.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const dbPath = process.argv[2] || process.env.DB_PATH;
if (!dbPath) throw new Error("Укажите путь к базе");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

const agent = db.prepare("SELECT id, client_id, config, version FROM agents WHERE name = 'Консультант YABOT'").get();
if (!agent) throw new Error("Агент «Консультант YABOT» не найден");

const OLD_PRICES = "Орієнтовні ціни стікерпаків, грн: статичні 5/10/15–20 шт — 500/900/1600; анімовані — 900/1700/3200. Точна сума — після брифу.";
const NEW_PRICES = "Актуальні орієнтовні ціни, пакети й графік роботи — у базі знань (документ «Послуги та ціни», його оновлює бот замовлень). Точна сума — після брифу.";
const OLD_INDIVIDUAL = "Ціни на персонажів і Telegram-ботів — індивідуально, після обговорення задачі.";
const NEW_INDIVIDUAL = "Ціни на персонажів і Telegram-ботів — індивідуально, після обговорення задачі (якщо в «Послуги та ціни» немає пакетів з цінами «від»).";
const OLD_HOURS = "Графік: Пн–Пт 10:00–19:00 за Києвом.";

db.exec("BEGIN");
try {
  const setKey = db.prepare("UPDATE kb_sources SET external_key = ? WHERE client_id = ? AND title = ? AND external_key IS NULL");
  const keyed = [
    ["services", "Послуги та ціни"],
    ["faq", "Часті питання"],
  ].map(([key, title]) => `${title} → ${key}: ${setKey.run(key, agent.client_id, title).changes ? "да" : "уже/нет"}`);

  const config = JSON.parse(agent.config);
  const lines = String(config.knowledge || "").split("\n");
  const next = lines
    .filter((l) => l.trim() !== OLD_HOURS)
    .map((l) => (l.trim() === OLD_PRICES ? NEW_PRICES : l.trim() === OLD_INDIVIDUAL ? NEW_INDIVIDUAL : l));
  let versioned = "без изменений";
  if (next.join("\n") !== lines.join("\n")) {
    config.knowledge = next.join("\n");
    const version = agent.version + 1;
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
    db.prepare("INSERT INTO agent_versions (id, agent_id, version, name, config, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), agent.id, version, "Ціни й графік — з бота замовлень", JSON.stringify(config), admin?.id ?? null, Date.now(),
    );
    db.prepare("UPDATE agents SET config = ?, version = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(config), version, Date.now(), agent.id);
    versioned = `версия ${version}`;
  }
  db.exec("COMMIT");
  console.log([...keyed, `Факты агента: ${versioned}`].join("\n"));
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
