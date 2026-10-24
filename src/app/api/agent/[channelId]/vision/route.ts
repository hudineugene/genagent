import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels } from "@/db/schema";
import { apiKey, withKeys } from "@/lib/keys";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { apiChannel } from "@/lib/channels/api-auth";
import { logUsage } from "@/lib/usage";

/**
 * Свой бот присылает фото (упаковка лекарства, рецепт, документ) — дешёвая модель читает с него нужное:
 * например, название препарата и дозировку. Только то, что напечатано на фото; ничего не советует.
 * Ответ: { text } или { text: null }, если прочитать не удалось.
 */
const MODEL = "claude-haiku-5-5";
const MAX_BYTES = 4 * 1024 * 1024;

const bodySchema = z.object({
  user: z.object({ id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)) }).optional(),
  image: z.string().min(100).max(Math.ceil((MAX_BYTES * 4) / 3) + 8),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
  task: z.string().trim().min(5).max(400),
});

async function handle(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const key = apiKey("anthropic");
  if (!key) return Response.json({ text: null, reason: "no_key" });
  const { image, mediaType, task } = parsed.data;

  const started = Date.now();
  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: MODEL,
      // Запас на размышление модели: при 200 оно съедало лимит, и текст приходил пустым
      max_tokens: 4000,
      output_config: { effort: "low" },
      system:
        "Ты читаешь текст с фотографии для бота компании. Отвечай только тем, что прямо напечатано на фото, без пояснений и советов. Если прочитать нужное не получается — ответь ровно одним словом: NONE.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: task },
          ],
        },
      ],
    });
    await logUsage({
      source: "insights",
      model: `anthropic:${MODEL}`,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, cacheReadTokens: res.usage.cache_read_input_tokens ?? 0 },
      agentId: channel.agentId,
      clientId: channel.clientId,
      ms: Date.now() - started,
    }).catch(() => {});
    const text = res.stop_reason === "max_tokens" ? "" : res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return Response.json({ text: !text || /^NONE\.?$/i.test(text) ? null : text.slice(0, 300) });
  } catch (e) {
    console.error("vision failed", e);
    return Response.json({ text: null, reason: "error" });
  }
}

/** Всё, что делается по запросу канала, — в области ключей клиента этого канала. */
export async function POST(req: Request, ctx: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await ctx.params;
  const [ch] = await db.select({ clientId: channels.clientId }).from(channels).where(eq(channels.id, channelId));
  return withKeys({ clientId: ch?.clientId }, () => handle(req, { params: Promise.resolve({ channelId }) }));
}
