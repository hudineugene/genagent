import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "@/db/client";
import { withKeys } from "@/lib/keys";
import { analyzeDocument, readDocument } from "./intake";

/**
 * Архив документов клиента: загруженные файлы (договоры, КП, отчёты, счета) хранятся рядом с базой (папка docs),
 * тип определяется сам, файл получает единое имя по шаблону типа и попадает в папку типа; неизвестные — в «Разное».
 */
export const DOCS_DIR = path.join(path.dirname(DB_PATH), "docs");
export const ARCHIVE_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".csv", ".html", ".htm", ".json", ".xlsx", ".jpg", ".jpeg", ".png"];
export const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
export const ARCHIVE_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

async function archiveOne__(clientId: string, f: { buf: Buffer; filename: string }) {
  const ext = path.extname(f.filename).toLowerCase();
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  const file = `${randomUUID()}${ext}`;
  fs.writeFileSync(path.join(DOCS_DIR, file), f.buf);
  const image = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" } as const)[ext as ".jpg"];
  // Фото / скан документа — описание с надписями дословно (по нему определяется тип и поля)
  const text = image
    ? f.buf.length <= 5 * 1024 * 1024
      ? ((await import("@/lib/media").then((m) => m.describePhoto(f.buf.toString("base64"), image, { agentId: null, clientId }, `Документ: ${f.filename}`))) ?? "")
      : ""
    : ((await readDocument(f.buf, f.filename)) ?? "");
  return analyzeDocument({ clientId, agentId: null, conversationId: null, messageId: null, filename: f.filename, text, archive: { file, size: f.buf.length } });
}

/** Разложить файлы по папкам (по одному, в области ключей клиента). */
export async function archiveFiles(clientId: string, files: { buf: Buffer; filename: string }[]) {
  return withKeys({ clientId }, async () => {
    const out = [];
    for (const f of files) out.push(await archiveOne__(clientId, f).catch((e) => (console.error("archive failed", f.filename, e), null)));
    return out;
  });
}

export function removeArchived(file: string) {
  if (ARCHIVE_NAME.test(file)) fs.rmSync(path.join(DOCS_DIR, file), { force: true });
}
