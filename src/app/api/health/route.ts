import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

// Проверка готовности для лаунчера, сервера и YABOT Панели: 200 — сервер отвечает и база доступна.
export async function GET() {
  await connection();
  try {
    await db.run(sql`select 1`);
    return Response.json({ app: "genagent", ok: true });
  } catch {
    return Response.json({ app: "genagent", ok: false }, { status: 503 });
  }
}
