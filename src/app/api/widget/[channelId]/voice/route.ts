import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channels, type WidgetConfig } from "@/db/schema";

/**
 * Голосовой ввод виджета: запись посетителя (WAV 16 кГц, base64, до минуты) → текст. Распознавание — на сервере
 * студии (без сторонних сервисов). Только у виджета с включённым голосом; не чаще 10 записей в минуту с адреса.
 */
const schema = z.object({ visitor: z.string().min(8).max(64), lang: z.string().max(5).optional(), data: z.string().min(100).max(2_800_000) });

const g = globalThis as unknown as { __widgetVoice?: Map<string, number[]> };
const hits = (g.__widgetVoice ??= new Map());

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(channelId)) return Response.json({ error: "not_found" }, { status: 404 });
  const [ch] = await db.select().from(channels).where(and(eq(channels.id, channelId), eq(channels.type, "widget"), eq(channels.enabled, true)));
  if (!ch || !(ch.config as WidgetConfig).voice) return Response.json({ error: "voice_off" }, { status: 404 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t: number) => now - t < 60_000);
  if (list.length >= 10) return Response.json({ error: "rate_limited" }, { status: 429 });
  hits.set(ip, [...list, now]);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  // Заглушка распознавания для автотестов
  if (process.env.ASR_TEST_TEXT) return Response.json({ text: process.env.ASR_TEST_TEXT });
  try {
    const { transcribeAudio } = await import("@/lib/asr");
    const r = await transcribeAudio(new Uint8Array(Buffer.from(parsed.data.data, "base64")), "wav", parsed.data.lang?.slice(0, 2));
    return r.text ? Response.json({ text: r.text }) : Response.json({ error: "empty" }, { status: 422 });
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    return Response.json({ error: code }, { status: 422 });
  }
}
