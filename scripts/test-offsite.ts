/**
 * Проверка копии базы в Telegram: поддельный Bot API принимает файл, затем scripts/restore-backup.mjs его расшифровывает.
 *   DB_PATH=<копия> TELEGRAM_API_URL=http://127.0.0.1:4021 npx tsx scripts/test-offsite.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { db } from "@/db";
import { saveNotifySettings } from "@/lib/notify/telegram";
import { deriveKey, saveOffsiteSettings, sendOffsiteBackup, getOffsiteSettings } from "@/lib/offsite-backup";

async function main() {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-"));
  let received = null as { name: string; bytes: Buffer; chatId: string } | null;
  const server = http
    .createServer(async (req, res) => {
      // Приём команд бота уведомлений тоже ходит сюда (getUpdates) — отвечаем пустым списком.
      if (!String(req.headers["content-type"]).startsWith("multipart/")) {
        req.resume();
        await new Promise((r) => setTimeout(r, 500));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: [] }));
      }
      const form = await new Request("http://x" + req.url, { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: req as unknown as BodyInit, duplex: "half" } as RequestInit).formData();
      const file = form.get("document") as File;
      received = { name: file.name, bytes: Buffer.from(await file.arrayBuffer()), chatId: String(form.get("chat_id")) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    })
    .listen(4021, "127.0.0.1");

  await saveNotifySettings({ token: "777:AAAAAAAAAAAAAAAAAAAAAAAAAAAA", botUsername: "x", linkCode: "c", adminUrl: "", subscribers: [{ chatId: "5001", name: "Женя", since: Date.now() }] });
  await saveOffsiteSettings({ enabled: true, chatId: "5001", ...deriveKey("correct horse battery") });

  const snapshot = path.join(dir, "genagent-202610150300.db");
  db.$sqlite.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  const result = await sendOffsiteBackup(snapshot);
  console.log("отправка:", result, "| получатель:", received?.chatId, "| файл:", received?.name, received?.bytes.length, "байт");
  console.log("настройки после:", { lastSentAt: Boolean((await getOffsiteSettings())?.lastSentAt) });

  const gab = path.join(dir, received!.name);
  fs.writeFileSync(gab, received!.bytes);
  const restore = path.resolve("scripts/restore-backup.mjs");
  try {
    execFileSync(process.execPath, [restore, gab], { env: { ...process.env, BACKUP_PASSWORD: "wrong password!" }, stdio: "pipe" });
    console.log("неверный пароль: расшифровалось (ПЛОХО)");
  } catch (e) {
    console.log("неверный пароль:", String((e as { stderr?: Buffer }).stderr).trim());
  }
  console.log(execFileSync(process.execPath, [restore, gab], { env: { ...process.env, BACKUP_PASSWORD: "correct horse battery" } }).toString().trim());
  const restored = new DatabaseSync(gab.replace(/\.gab$/, ".db"), { readOnly: true });
  const original = new DatabaseSync(snapshot, { readOnly: true });
  const count = (d: DatabaseSync) => (d.prepare("select count(*) n from messages").get() as { n: number }).n;
  console.log("сообщений в оригинале и в восстановленной:", count(original), count(restored));

  await saveNotifySettings(null);
  await db.$sqlite.exec("delete from settings where key = 'offsiteBackup'");
  server.close();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
