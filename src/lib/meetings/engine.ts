import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey as keyOf } from "@/lib/keys";
import path from "node:path";
import { eq } from "drizzle-orm";
import OpenAI, { toFile } from "openai";
import { db } from "@/db";
import { clients, meetings, type Meeting, type MeetingTask } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Встречи и звонки: запись → расшифровка (OpenAI, ключ из «Внешних сервисов»), готовая расшифровка (Zoom, Meet,
 * Teams: .vtt, .srt, .txt, .docx, .pdf) → разбор моделью по виду: протокол, собеседование, звонок продаж, своё.
 */
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".webm", ".mp4", ".mpeg", ".mpga", ".ogg", ".oga", ".flac"];
export const TEXT_EXTENSIONS = [".txt", ".vtt", ".srt", ".md", ".docx", ".pdf"];
/** Ограничение OpenAI на один файл */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MODEL = "claude-sonnet-5-5";
const TRANSCRIPT_CHARS = 400_000;

/** Субтитры (VTT/SRT) → текст: без номеров и таймкодов, повторы подряд схлопнуты. */
export function cleanSubtitles(text: string) {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l !== "WEBVTT" && !/^\d+$/.test(l) && !/-->/.test(l) && !/^(NOTE|STYLE|Kind:|Language:)/.test(l))
    .map((l) => l.replace(/<v\s+([^>]+)>/g, "$1: ").replace(/<[^>]+>/g, ""));
  return lines.filter((l, i) => l !== lines[i - 1]).join("\n");
}

export async function transcriptFromFile(buf: Buffer, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".vtt" || ext === ".srt") return cleanSubtitles(buf.toString("utf8"));
  if (ext === ".txt" || ext === ".md") return buf.toString("utf8").replace(/^﻿/, "").trim();
  const { extractFile } = await import("@/lib/kb/extract");
  return (await extractFile(buf, filename)).text.trim();
}

/** Расшифровка записи. gpt-4o-transcribe точнее; если не вышло — whisper-1. */
export async function transcribeAudio(buf: Buffer, filename: string): Promise<string> {
  const key = keyOf("openai");
  if (!key) throw new Error("no_openai");
  if (buf.length > MAX_AUDIO_BYTES) throw new Error("too_large");
  const client = new OpenAI({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL || undefined });
  try {
    const r = await client.audio.transcriptions.create({ file: await toFile(buf, filename), model: "gpt-4o-transcribe", chunking_strategy: "auto" });
    return r.text.trim();
  } catch (e) {
    console.error("gpt-4o-transcribe failed, falling back to whisper-1", e instanceof Error ? e.message : e);
    const r = await client.audio.transcriptions.create({ file: await toFile(buf, filename), model: "whisper-1" });
    return r.text.trim();
  }
}

const KIND_TASK: Record<Meeting["kind"], string> = {
  protocol:
    "Составь протокол встречи: ## Кратко (2–3 предложения), ## Участники (если понятны), ## Что обсуждали (пункты), ## Решения, ## Задачи (кто — что — срок), ## Открытые вопросы. score — null.",
  interview:
    "Разбери собеседование: ## Кратко о кандидате, ## Оценка по критериям (каждый критерий — оценка 1–10 и почему, с цитатами), ## Сильные стороны, ## Риски и красные флаги, ## Что уточнить, ## Рекомендация (брать / не брать / второй этап). score — общая оценка 1–10.",
  sales:
    "Разбери звонок продаж: ## Кратко, ## Потребности клиента, ## Возражения и как менеджер их отработал, ## Договорённости и следующий шаг, ## Соблюдение чек-листа (каждый пункт — да/нет/частично), ## Что улучшить (конкретные фразы). score — оценка работы менеджера 1–10.",
  custom: "Выполни задание пользователя по расшифровке. score — оценка 1–10, если задание про оценку, иначе null.",
};

type Analysis = { title: string; summary: string; result: string; tasks: MeetingTask[]; score: number | null };

/** Разбор расшифровки моделью; результат — в meetings, задачи — в Telegram и внешние системы. */
export async function analyzeMeeting(id: string) {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, id));
  if (!m) return null;
  const apiKey = keyOf("anthropic");
  if (!apiKey) throw new Error("no_key");
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, m.clientId));
  const today = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", dateStyle: "long" }).format(m.createdAt);
  const started = Date.now();
  const { data, usage, model } = await generateJson<Analysis>(apiKey, MODEL, {
    system: [
      `Ты помощник компании «${client?.name ?? ""}». Дата записи: ${today}. Перед тобой расшифровка встречи или звонка (может быть с ошибками распознавания — исправляй очевидное по смыслу).`,
      KIND_TASK[m.kind],
      m.instructions ? `${m.kind === "interview" ? "Критерии оценки" : m.kind === "sales" ? "Чек-лист звонка" : "Задание"}: ${m.instructions}` : "",
      "Пиши по-русски (или на языке задания), конкретно, с цифрами и именами из записи; ничего не выдумывай — чего нет в записи, так и отметь. result — разбор в markdown по структуре выше.",
      "title — короткое название встречи (до 60 знаков). summary — 1–2 предложения для уведомления. tasks — все договорённости-поручения: who (кто, если понятно), what, due (срок как сказано, иначе пусто).",
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: `Расшифровка:\n${m.transcript.slice(0, TRANSCRIPT_CHARS)}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary", "result", "tasks", "score"],
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        result: { type: "string" },
        tasks: { type: "array", items: { type: "object", additionalProperties: false, required: ["who", "what", "due"], properties: { who: { type: "string" }, what: { type: "string" }, due: { type: "string" } } } },
        score: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    },
    effort: "medium",
  });
  await logUsage({ source: "insights", model, usage, clientId: m.clientId, ms: Date.now() - started }).catch(() => {});
  const score = typeof data.score === "number" ? Math.min(10, Math.max(1, Math.round(data.score))) : null;
  const tasks = data.tasks.filter((t) => t.what.trim()).slice(0, 50).map((t) => ({ who: t.who.trim().slice(0, 100), what: t.what.trim().slice(0, 500), due: t.due.trim().slice(0, 60) }));
  const [row] = await db
    .update(meetings)
    .set({ title: m.title || data.title.trim().slice(0, 120), summary: data.summary.trim().slice(0, 1000), result: data.result.trim().slice(0, 50_000), tasks, score, status: "done", error: null, updatedAt: new Date() })
    .where(eq(meetings.id, id))
    .returning();
  void import("@/lib/integrations/events").then((e) =>
    e.emitEvent("meeting", { clientId: row.clientId, meeting: { title: row.title, kind: row.kind, summary: row.summary, tasks: row.tasks, score: row.score } }),
  );
  if (row.delivery.team || row.delivery.owners) await deliverMeeting(row).catch((e) => console.error("meeting deliver failed", e));
  return row;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Итоги встречи — в Telegram сотрудникам студии и/или владельцам бизнеса. */
export async function deliverMeeting(m: Meeting) {
  const icon = m.kind === "interview" ? "🧑‍💼" : m.kind === "sales" ? "📞" : "🗒";
  const html = [
    `${icon} <b>${esc(m.title || "Встреча")}</b>${m.score != null ? ` · оценка <b>${m.score}/10</b>` : ""}`,
    "",
    esc(m.summary),
    m.tasks.length ? `\n<b>Задачи</b>\n${m.tasks.map((t) => `• ${t.who ? `<b>${esc(t.who)}</b>: ` : ""}${esc(t.what)}${t.due ? ` — до ${esc(t.due)}` : ""}`).join("\n")}` : "",
  ]
    .join("\n")
    .slice(0, 3900);
  const n = await import("@/lib/notify/telegram");
  if (m.delivery.team) await n.sendToTeam(html);
  if (m.delivery.owners) await n.sendToOwners(m.clientId, html);
}

/** Полная обработка новой встречи: расшифровка (если запись) и разбор. Ошибки — в статус. */
async function processMeeting__(id: string, file?: { buf: Buffer; filename: string; audio: boolean }) {
  try {
    if (file) {
      const transcript = file.audio ? await transcribeAudio(file.buf, file.filename) : await transcriptFromFile(file.buf, file.filename);
      if (!transcript.trim()) throw new Error("empty");
      await db.update(meetings).set({ transcript: transcript.slice(0, TRANSCRIPT_CHARS), updatedAt: new Date() }).where(eq(meetings.id, id));
    }
    return await analyzeMeeting(id);
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    if (!["no_openai", "too_large", "empty", "no_key"].includes(code)) console.error("meeting processing failed", id, e);
    await db.update(meetings).set({ status: "error", error: code.slice(0, 500), updatedAt: new Date() }).where(eq(meetings.id, id));
    return null;
  }
}

/** processMeeting — в области ключей клиента (его ключи ИИ, если заданы). */
export async function processMeeting(...a: Parameters<typeof processMeeting__>): ReturnType<typeof processMeeting__> {
  const [m] = await db.select({ clientId: meetings.clientId }).from(meetings).where(eq(meetings.id, a[0]));
  return withKeys({ clientId: m?.clientId }, () => processMeeting__(...a));
}
