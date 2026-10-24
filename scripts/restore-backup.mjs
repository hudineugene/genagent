// Расшифровка копии GenAgent из Telegram (.gab): база → .db, архив файлов (genagent-files-…) → .tar.gz
// (распаковать в папку data: tar -xzf genagent-files-….tar.gz -C data — появятся media и docs).
//   node scripts/restore-backup.mjs genagent-202610150300.gab
// Спросит пароль копии (тот, что задан в «Интеграциях → Копия базы в Telegram»).
// Восстановление на сервере: остановить контейнер, положить файл как data/genagent.db, запустить.
import { createDecipheriv, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createInterface } from "node:readline/promises";

const file = process.argv[2];
if (!file) {
  console.error("Укажите файл копии: node scripts/restore-backup.mjs <файл.gab>");
  process.exit(1);
}
const data = readFileSync(file);
if (data.subarray(0, 4).toString() !== "GAB1") {
  console.error("Это не копия GenAgent (нет метки GAB1)");
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = process.env.BACKUP_PASSWORD ?? (await rl.question("Пароль копии: "));
rl.close();

const salt = data.subarray(4, 20);
const iv = data.subarray(20, 32);
const tag = data.subarray(32, 48);
try {
  const decipher = createDecipheriv("aes-256-gcm", scryptSync(password, salt, 32), iv);
  decipher.setAuthTag(tag);
  const raw = gunzipSync(Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]));
  const base = file.replace(/\.gab$/i, "");
  const out = /genagent-files-/.test(base) ? `${base}.tar.gz` : `${base}.db`;
  writeFileSync(out, raw);
  console.log(`Готово: ${out} (${(raw.length / 1024).toFixed(0)} КБ)`);
} catch {
  console.error("Не удалось расшифровать: неверный пароль или файл повреждён");
  process.exit(1);
}
