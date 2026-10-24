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

/** Счётчики для /api/health: занятость базы за сутки и время последних записей (один набор на процесс). */
const stats = ((globalThis as unknown as { __dbStats?: { busy: number[]; writes: number[] } }).__dbStats ??= { busy: [], writes: [] });

const isBusy = (e: unknown) => /SQLITE_BUSY|database is locked/i.test(String((e as { errstr?: string })?.errstr ?? (e as Error)?.message ?? e));

export function dbStats() {
  const day = Date.now() - 86400_000;
  stats.busy = stats.busy.filter((t) => t > day);
  const w = [...stats.writes].sort((a, b) => a - b);
  return { busyDay: stats.busy.length, writeP95Ms: w.length ? Math.round(w[Math.min(w.length - 1, Math.floor(w.length * 0.95))] * 10) / 10 : null, writes: w.length };
}

export function createDb(sqlite = openSqlite()) {
  const db = drizzle(
    async (sql, params, method) => {
      const t = performance.now();
      try {
        const stmt = sqlite.prepare(sql);
        if (method === "run") {
          stmt.run(...params);
          return { rows: [] };
        }
        stmt.setReturnArrays(true);
        if (method === "get") return { rows: (stmt.get(...params) as unknown[] | undefined) ?? [] };
        return { rows: stmt.all(...params) as unknown[] };
      } catch (e) {
        if (isBusy(e) && stats.busy.push(Date.now()) > 1000) stats.busy.shift();
        throw e;
      } finally {
        // запись — всё, кроме select (insert … returning приходит как get/all)
        if (!/^\s*(select|with)\b/i.test(sql) && stats.writes.push(performance.now() - t) > 500) stats.writes.shift();
      }
    },
    { schema },
  );
  return Object.assign(db, { $sqlite: sqlite });
}

export type Db = ReturnType<typeof createDb>;
