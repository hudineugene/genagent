import { statSync } from "node:fs";
import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { DB_PATH, dbStats } from "@/db/client";

const mb = (file: string) => {
  try {
    return statSync(file).size / 1048576;
  } catch {
    return 0;
  }
};

// Проверка готовности для лаунчера, сервера и YABOT Панели: 200 — сервер отвечает и база доступна.
// db — признаки, когда пора уходить с SQLite (docs/sqlite-migration-plan.md): размер, занятость за сутки, p95 записи.
export async function GET() {
  await connection();
  try {
    await db.run(sql`select 1`);
    const s = dbStats();
    return Response.json({
      app: "genagent",
      ok: true,
      db: { sizeMb: Math.round((mb(DB_PATH) + mb(`${DB_PATH}-wal`)) * 10) / 10, busyDay: s.busyDay, writeP95Ms: s.writeP95Ms, writes: s.writes },
    });
  } catch {
    return Response.json({ app: "genagent", ok: false }, { status: 503 });
  }
}
