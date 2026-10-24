import { apiKey } from "@/lib/keys";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, meetings } from "@/db/schema";
import { findCurrentUser } from "@/lib/auth";
import { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES, TEXT_EXTENSIONS, processMeeting } from "@/lib/meetings/engine";

const KINDS = ["protocol", "interview", "sales", "custom"] as const;

/**
 * Новая встреча: запись (аудио/видео до 25 МБ), файл расшифровки или вставленный текст. Обработка идёт в фоне,
 * ответ — сразу (id); страница сама обновляет статус.
 * Поля формы: clientId, kind, title?, instructions?, team?, owners?, file? | text?
 */
export async function POST(req: Request) {
  if (!(await findCurrentUser())) return new Response("Unauthorized", { status: 401 });
  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
  if (!client) return Response.json({ error: "client_not_found" }, { status: 404 });
  const kind = KINDS.find((k) => k === form.get("kind")) ?? "protocol";
  const title = String(form.get("title") ?? "").trim().slice(0, 120);
  const instructions = String(form.get("instructions") ?? "").trim().slice(0, 3000);
  const delivery = { team: form.get("team") === "1", owners: form.get("owners") === "1" };
  const file = form.get("file");
  const text = String(form.get("text") ?? "").trim();

  let input: { buf: Buffer; filename: string; audio: boolean } | undefined;
  if (file instanceof File && file.size > 0) {
    const ext = path.extname(file.name).toLowerCase();
    const audio = AUDIO_EXTENSIONS.includes(ext);
    if (!audio && !TEXT_EXTENSIONS.includes(ext)) return Response.json({ error: "unsupported" }, { status: 400 });
    if (file.size > (audio ? MAX_AUDIO_BYTES : 10 * 1024 * 1024)) return Response.json({ error: "too_large" }, { status: 400 });
    if (audio && !apiKey("openai")) return Response.json({ error: "no_openai" }, { status: 400 });
    input = { buf: Buffer.from(await file.arrayBuffer()), filename: file.name, audio };
  } else if (text.length < 50) return Response.json({ error: "no_input" }, { status: 400 });

  const [row] = await db
    .insert(meetings)
    .values({ clientId, kind, title, instructions, delivery, filename: input?.filename.slice(0, 200) ?? "", transcript: input ? "" : text.slice(0, 400_000) })
    .returning({ id: meetings.id });
  void processMeeting(row.id, input);
  return Response.json({ id: row.id });
}
