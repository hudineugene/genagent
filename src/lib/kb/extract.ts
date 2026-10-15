import "server-only";
import path from "node:path";
import { normalizeText } from "./text";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".csv", ".html", ".htm", ".json"];

export class ExtractError extends Error {}

/** Достаёт текст из файла: PDF, Word (.docx), текстовые форматы. */
export async function extractFile(buffer: Buffer, filename: string): Promise<{ text: string; pages: number }> {
  const ext = path.extname(filename).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new ExtractError(`unsupported:${ext || "?"}`);
  }

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((p) => normalizeText(p)).filter(Boolean);
    return { text: pages.join("\n\n"), pages: totalPages };
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: normalizeText(value), pages: 1 };
  }

  const raw = buffer.toString("utf8");
  if (ext === ".html" || ext === ".htm") {
    const { htmlToText } = await import("./crawl");
    return { text: htmlToText(raw, "").text, pages: 1 };
  }
  return { text: normalizeText(raw), pages: 1 };
}
