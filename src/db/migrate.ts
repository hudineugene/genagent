import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import type { Db } from "./client";

export async function runMigrations(db: Db) {
  await migrate(
    db,
    async (queries) => {
      db.$sqlite.exec("BEGIN");
      try {
        for (const q of queries) db.$sqlite.exec(q);
        db.$sqlite.exec("COMMIT");
      } catch (e) {
        db.$sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    { migrationsFolder: "./drizzle" },
  );
}
