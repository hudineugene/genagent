/**
 * Первичная настройка: создаёт .env (если нет), применяет миграции БД,
 * заводит администратора студии и демо-клиента.
 * Запуск: npm run setup (лаунчер GenAgent.cmd делает это сам при первом запуске).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { count } from "drizzle-orm";

const ENV_PATH = ".env";

function ensureEnv() {
  let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const add = (key: string, value: string, comment?: string) => {
    if (new RegExp(`^${key}=`, "m").test(env)) return;
    env += `${env && !env.endsWith("\n") ? "\n" : ""}${comment ? `# ${comment}\n` : ""}${key}=${value}\n`;
  };
  add("SESSION_PASSWORD", randomBytes(32).toString("hex"), "Ключ шифрования сессий (не менять без нужды)");
  add("ANTHROPIC_API_KEY", "", "Ключи провайдеров моделей");
  add("OPENAI_API_KEY", "");
  add("OPENROUTER_API_KEY", "");
  add("SEED_ADMIN_EMAIL", "admin@studio.local", "Первый администратор (создаётся командой npm run setup)");
  add("SEED_ADMIN_PASSWORD", randomBytes(9).toString("base64url"));
  writeFileSync(ENV_PATH, env);
  process.loadEnvFile(ENV_PATH);
}

async function main() {
  ensureEnv();

  const { createDb } = await import("../src/db/client");
  const { runMigrations } = await import("../src/db/migrate");
  const { users, clients } = await import("../src/db/schema");

  const db = createDb();
  await runMigrations(db);
  console.log("✓ Миграции применены");

  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n === 0) {
    const email = process.env.SEED_ADMIN_EMAIL!.toLowerCase();
    await db.insert(users).values({
      email,
      name: "Администратор",
      role: "admin",
      passwordHash: await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD!, 10),
    });
    console.log(`✓ Администратор создан: ${email} (пароль — SEED_ADMIN_PASSWORD в .env)`);
  } else {
    console.log("• Пользователи уже есть, пропускаю");
  }

  const [{ c }] = await db.select({ c: count() }).from(clients);
  if (c === 0) {
    await db.insert(clients).values({
      name: "Демо: Стоматология «Усмешка»",
      industry: "Стоматология",
      website: "https://example.com",
      description:
        "Семейная стоматология в Киеве, 2 филиала. Лечение, чистка, имплантация, детский врач. Работаем ежедневно 9:00–20:00.",
      brandVoice: "Тёплый и заботливый, на «вы». Успокаиваем тех, кто боится лечения. Без медицинского жаргона.",
      color: "#0ea5e9",
    });
    console.log("✓ Демо-клиент создан");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
