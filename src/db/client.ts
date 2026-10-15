import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

export const DB_PATH = process.env.DB_PATH ?? "./data/genagent.db";

/**
 * SQLite, встроенный в Node.js: один файл, без сервера и нативных модулей.
 * Режим WAL + synchronous=FULL — каждая запись сразу на диске, база переживает внезапное закрытие.
 */
export function openSqlite(file = DB_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return sqlite;
}

export function createDb(sqlite = openSqlite()) {
  const db = drizzle(
    async (sql, params, method) => {
      const stmt = sqlite.prepare(sql);
      if (method === "run") {
        stmt.run(...params);
        return { rows: [] };
      }
      stmt.setReturnArrays(true);
      if (method === "get") return { rows: (stmt.get(...params) as unknown[] | undefined) ?? [] };
      return { rows: stmt.all(...params) as unknown[] };
    },
    { schema },
  );
  return Object.assign(db, { $sqlite: sqlite });
}

export type Db = ReturnType<typeof createDb>;
