import "server-only";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/db";

const KEEP = 14;
const EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Резервные копии базы раз в сутки в BACKUP_DIR (на сервере): согласованный снимок через VACUUM INTO,
 * хранятся последние 14. YABOT Панель видит эту папку как «копии данных» бота.
 * Свежая копия дополнительно уходит в Telegram зашифрованной (offsite-backup.ts), если это включено.
 */
/** Последняя копия на сервере — для кнопки «Отправить сейчас». */
export function latestBackup(dir = process.env.BACKUP_DIR ?? "") {
  if (!dir || !fs.existsSync(dir)) return null;
  const last = list(dir).at(-1);
  return last ? path.join(dir, last) : null;
}

export function startBackups(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const run = () => {
    try {
      const files = list(dir);
      const last = files.at(-1);
      if (last && Date.now() - fs.statSync(path.join(dir, last)).mtimeMs < EVERY_MS - 60_000) return;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const target = path.join(dir, `genagent-${stamp}.db`);
      db.$sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      for (const old of list(dir).slice(0, -KEEP)) fs.rmSync(path.join(dir, old), { force: true });
      // Копия вне сервера — в Telegram, зашифрованная (если включено в «Интеграциях»).
      void import("./offsite-backup").then((m) => m.sendOffsiteBackup(target));
    } catch (e) {
      console.error("backup failed", e);
    }
  };
  run();
  // Проверяем каждые 10 минут: копия появляется не позже чем через сутки и 10 минут после предыдущей
  setInterval(run, 10 * 60 * 1000).unref();
}

function list(dir: string) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^genagent-\d{12}\.db$/.test(f))
    .sort();
}
