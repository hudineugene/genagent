import "server-only";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clientDocTypes, clientDocuments, messages, type ClientDocType } from "@/db/schema";
import { ACCEPTED_EXTENSIONS, extractFile } from "@/lib/kb/extract";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Документы от клиентов: файл (PDF, Word, текст) → текст, который агент читает в разговоре; фото документа —
 * описание с надписями. Если у клиента заданы типы документов — дешёвая модель определяет тип и достаёт поля
 * (счёт: поставщик, сумма, дата…); результат сохраняется, приходит менеджеру и уходит во внешние системы.
 */
const MODEL = "claude-haiku-5-5";
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
/** Сколько текста документа держим в разговоре */
const KEEP_CHARS = 20_000;

/** Текст файла или null (формат не поддерживается / не прочитался). */
export async function readDocument(buf: Buffer, filename: string): Promise<string | null> {
  const ext = path.extname(filename).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) return null;
  try {
    const { text } = await extractFile(buf, filename);
    return text.trim() ? text.trim().slice(0, KEEP_CHARS) : null;
  } catch (e) {
    console.error("document extract failed", filename, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Прикрепить к сообщению клиента документ (агент увидит его текст) и разобрать по типам документов клиента. */
export async function attachDocument(
  messageId: string,
  doc: { name: string; text: string },
  owner: { clientId: string; agentId: string; conversationId: string },
) {
  const [m] = await db.select({ meta: messages.meta }).from(messages).where(eq(messages.id, messageId));
  await db
    .update(messages)
    .set({ meta: { ...m?.meta, kind: m?.meta?.kind ?? "document", document: { name: doc.name, text: doc.text.slice(0, KEEP_CHARS) } } })
    .where(eq(messages.id, messageId));
  void analyzeDocument({ ...owner, messageId, filename: doc.name, text: doc.text }).catch((e) => console.error("document analysis failed", e));
}

type Extracted = { type: string; fields: { key: string; value: string }[]; summary: string };

/** Определить тип и достать поля. null — у клиента нет типов документов или документ ни под один не подходит. */
export async function analyzeDocument(d: { clientId: string; agentId: string; conversationId: string | null; messageId: string | null; filename: string; text: string }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const types = await db.select().from(clientDocTypes).where(and(eq(clientDocTypes.clientId, d.clientId), eq(clientDocTypes.enabled, true)));
  if (!apiKey || !types.length || !d.text.trim()) return null;
  const started = Date.now();
  const { data, usage, model } = await generateJson<Extracted>(apiKey, MODEL, {
    system: [
      "Определи, к какому из типов относится документ, и достань из него поля этого типа — точно как написано в документе (числа, даты, имена, суммы с валютой).",
      "Поля, которых в документе нет, — пустая строка; не выдумывай. type — ключ типа или \"none\", если документ ни к одному не подходит.",
      "summary — 1–2 предложения по-русски: что это за документ и главное в нём (для менеджера).",
      "Типы:",
      ...types.map((t, i) => `[t${i}] ${t.name}: ${t.purpose || "—"}. Поля: ${t.fields.map((f) => `${f.key} — ${f.label}`).join("; ")}`),
    ].join("\n"),
    prompt: `Файл: ${d.filename}\n\n${d.text.slice(0, 30_000)}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["type", "fields", "summary"],
      properties: {
        type: { type: "string" },
        fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "value"], properties: { key: { type: "string" }, value: { type: "string" } } } },
        summary: { type: "string" },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId: d.agentId, clientId: d.clientId, conversationId: d.conversationId, ms: Date.now() - started }).catch(() => {});
  const docType: ClientDocType | undefined = types[Number(data.type.replace(/^t/, ""))];
  if (!docType || data.type === "none") return null;
  const known = new Map(docType.fields.map((f) => [f.key, f.label]));
  const fields = Object.fromEntries(data.fields.filter((f) => known.has(f.key) && f.value.trim()).map((f) => [f.key, f.value.trim().slice(0, 500)]));
  const [row] = await db
    .insert(clientDocuments)
    .values({ clientId: d.clientId, docTypeId: docType.id, conversationId: d.conversationId, messageId: d.messageId, filename: d.filename.slice(0, 200), fields, summary: data.summary.trim().slice(0, 500) })
    .returning();
  // Для людей и внешних систем — подписи полей вместо ключей
  const labeled = Object.fromEntries(Object.entries(fields).map(([k, v]) => [known.get(k) ?? k, v]));
  const payload = { type: docType.name, filename: row.filename, fields: labeled, summary: row.summary };
  void import("@/lib/integrations/events").then((m) => m.emitEvent("document", { clientId: d.clientId, agentId: d.agentId, conversationId: d.conversationId, document: payload }));
  if (docType.notify) void import("@/lib/notify/telegram").then((n) => n.notifyDocument(d.conversationId, d.clientId, payload));
  return row;
}
