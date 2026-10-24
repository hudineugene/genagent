/** Копия файлов: архив папок media и docs, хранятся последние 7, шифрование для Telegram и расшифровка скриптом
 *  восстановления обратно в .tar.gz, распаковка даёт те же файлы.  DB_PATH=<копия caltest> npx tsx scripts/test-backup-files.ts */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ga-backup-"));
  const data = path.join(root, "data");
  const backups = path.join(root, "backups");
  fs.mkdirSync(path.join(data, "media"), { recursive: true });
  fs.mkdirSync(path.join(data, "docs"), { recursive: true });
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(data, "media", "c_abc.png"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(data, "docs", "11111111-1111-1111-1111-111111111111.pdf"), "Договор №5");
  const { backupFiles } = await import("@/lib/backup");
  const { encryptBackup, deriveKey } = await import("@/lib/offsite-backup");
  const made: string[] = [];
  for (let i = 0; i < 9; i++) made.push(backupFiles(backups, `2026102${i}1200`, data) ?? "");
  const kept = fs.readdirSync(backups).filter((f) => f.startsWith("genagent-files-")).sort();
  // Шифрование → расшифровка скриптом восстановления → распаковка
  const k = deriveKey("password-1234567890");
  const gab = path.join(root, path.basename(made.at(-1)!).replace(/\.tar\.gz$/, ".gab"));
  fs.writeFileSync(gab, encryptBackup(fs.readFileSync(made.at(-1)!), k));
  execFileSync(process.execPath, ["scripts/restore-backup.mjs", gab], { env: { ...process.env, BACKUP_PASSWORD: "password-1234567890" }, stdio: "ignore" });
  const restored = gab.replace(/\.gab$/, ".tar.gz");
  const out = path.join(root, "restore");
  fs.mkdirSync(out);
  execFileSync(process.env.TAR_BIN || "tar", ["-xzf", restored, "-C", out], { stdio: "ignore" });
  const doc = fs.readFileSync(path.join(out, "docs", "11111111-1111-1111-1111-111111111111.pdf"), "utf8");
  const img = fs.readFileSync(path.join(out, "media", "c_abc.png"));
  const none = backupFiles(backups, "202610300000", path.join(root, "empty"));
  fs.rmSync(root, { recursive: true, force: true });

  const result: Record<string, boolean> = {
    "архив создан, хранятся последние 7": made.every(Boolean) && kept.length === 7 && kept[0] === "genagent-files-202610221200.tar.gz",
    "шифрование → расшифровка → распаковка: те же файлы": doc === "Договор №5" && img.equals(Buffer.from([1, 2, 3, 4])),
    "нет папок — архива нет": none === null,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
