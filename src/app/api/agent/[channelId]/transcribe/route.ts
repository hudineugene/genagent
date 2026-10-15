import { z } from "zod";
import { AsrError, transcribeOgg } from "@/lib/asr";
import { apiChannel } from "@/lib/channels/api-auth";

/**
 * Свой бот присылает голосовое клиента (OGG/Opus из Telegram) — GenAgent расшифровывает его на своём сервере
 * и возвращает текст; дальше бот обрабатывает его как обычное сообщение. Внешние сервисы и токены ИИ не тратятся.
 * Ответ: { text, seconds } (text: null — слов не разобрать) или { text: null, reason: too_long | bad_audio | unavailable }.
 */
const MAX_BYTES = 3 * 1024 * 1024;

const bodySchema = z.object({
  user: z.object({ id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)) }).optional(),
  audio: z.string().min(100).max(Math.ceil((MAX_BYTES * 4) / 3) + 8),
  format: z.literal("ogg").default("ogg"),
  // Язык клиента в боте (ru, uk…): язык речи определяется по записи, подсказка решает только спорные случаи.
  language: z.string().trim().toLowerCase().max(5).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { audio, language } = parsed.data;

  const started = Date.now();
  try {
    const r = await transcribeOgg(new Uint8Array(Buffer.from(audio, "base64")), language);
    console.log(`transcribe: agent ${channel.agentId}, ${r.seconds} s audio, ${r.language}, ${Date.now() - started} ms, ${r.text ? "ok" : "no speech"}`);
    return Response.json(r);
  } catch (e) {
    if (e instanceof AsrError) return Response.json({ text: null, reason: e.reason });
    console.error("transcribe failed", e);
    return Response.json({ text: null, reason: "error" });
  }
}
