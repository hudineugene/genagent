import "server-only";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { DB_PATH } from "@/db/client";

const KEEP = 14;
/** Архивов файлов храним меньше: они больше базы */
const KEEP_FILES = 7;
/** Папки с файлами рядом с базой: картинки постов и превью фото, архив документов клиентов */
const FILE_DIRS = ["media", "docs"];
const EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Резервные копии базы раз в сутки в BACKUP_DIR (на сервере): согласованный снимок через VACUUM INTO,
 * хранятся последние 14. YABOT Панель видит эту папку как «копии данных» бота.
 * Рядом — архив файлов (картинки, превью фото, архив документов: папки media и docs), хранятся последние 7.
 * Свежие копии дополнительно уходят в Telegram зашифрованными (offsite-backup.ts), если это включено.
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
      const filesArchive = backupFiles(dir, stamp);
      // Копии вне сервера — в Telegram, зашифрованные (если включено в «Интеграциях»).
      void import("./offsite-backup").then(async (m) => {
        await m.sendOffsiteBackup(target);
        if (filesArchive) await m.sendOffsiteBackup(filesArchive, "files");
      });
    } catch (e) {
      console.error("backup failed", e);
    }
  };
  run();
  // Проверяем каждые 10 минут: копия появляется не позже чем через сутки и 10 минут после предыдущей
  setInterval(run, 10 * 60 * 1000).unref();
}

/** Архив файлов (tar.gz) — если на сервере есть такие папки. null — нечего архивировать или не получилось. */
export function backupFiles(dir: string, stamp: string, dataDir = path.dirname(DB_PATH)) {
  const present = FILE_DIRS.filter((d) => fs.existsSync(path.join(dataDir, d)));
  if (!present.length) return null;
  const target = path.join(dir, `genagent-files-${stamp}.tar.gz`);
  try {
    execFileSync(process.env.TAR_BIN || "tar", ["-czf", target, "-C", dataDir, ...present], { stdio: "ignore", timeout: 10 * 60_000 });
  } catch (e) {
    console.error("files backup failed", e instanceof Error ? e.message : e);
    fs.rmSync(target, { force: true });
    return null;
  }
  const archives = fs
    .readdirSync(dir)
    .filter((f) => /^genagent-files-\d{12}\.tar\.gz$/.test(f))
    .sort();
  for (const old of archives.slice(0, -KEEP_FILES)) fs.rmSync(path.join(dir, old), { force: true });
  return target;
}

function list(dir: string) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^genagent-\d{12}\.db$/.test(f))
    .sort();
}
