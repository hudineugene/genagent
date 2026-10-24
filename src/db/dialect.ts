import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Всё, что в запросах зависит от SQLite, — здесь. При переходе на PostgreSQL меняются только эти функции
 * (план — docs/sqlite-migration-plan.md), а вызовы по коду остаются как есть.
 */

const PATH = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** Значение из JSON-поля по пути "a.b" (SQLite: json_extract; PostgreSQL: col->'a'->>'b'). */
export function jsonText<T = unknown>(col: SQLWrapper, path: string): SQL<T> {
  if (!PATH.test(path)) throw new Error(`jsonText: недопустимый путь ${path}`);
  return sql<T>`json_extract(${col}, ${sql.raw(`'$.${path}'`)})`;
}

/**
 * Порядок вставки сообщений — для строк с одинаковым временем (SQLite: rowid).
 * В PostgreSQL его заменит столбец seq bigserial.
 */
export const messageSeq = sql<number>`messages.rowid`;
