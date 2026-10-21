import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, channels, conversations } from "@/db/schema";
import { addMessage, upsertConversation } from "@/lib/conversations";
import { notifySiteLead } from "@/lib/notify/telegram";

/**
 * Форма заявки на сайте студии: имя, как связаться, что нужно. Заявка попадает во «Входящие» канала виджета
 * и сразу уходит сотрудникам студии в Telegram (бот уведомлений). Модель не вызывается.
 * Вызывается с сайта (другой домен), поэтому CORS — только для сайтов из ORIGINS, плюс ограничения частоты
 * и скрытое поле-ловушка для ботов (website): заполненное — тихо отвечаем «принято» и ничего не делаем.
 */

const ORIGINS = new Set(["https://yabotua.com", "https://www.yabotua.com"]);
const PER_IP = { limit: 3, windowMs: 10 * 60_000 };
const PER_CHANNEL_HOUR = 30;

function cors(origin: string | null): Record<string, string> {
  return origin && ORIGINS.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", Vary: "Origin", "Cache-Control": "no-store" }
    : { Vary: "Origin", "Cache-Control": "no-store" };
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: ORIGINS.has(origin ?? "") ? 204 : 403, headers: cors(origin) });
}

const hits = new Map<string, number[]>();
function tooMany(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 2500)) hits.delete(k);
  return false;
}

const oneLine = (max: number) => z.string().trim().max(max).transform((s) => s.replace(/\s+/g, " "));
const bodySchema = z.object({
  visitor: z.string().uuid(),
  lang: z.enum(["uk", "en"]).default("uk"),
  name: oneLine(80).pipe(z.string().min(1)),
  contact: oneLine(120).pipe(z.string().min(3)),
  need: z.string().trim().max(1500).default(""),
  page: oneLine(200).default(""),
  website: z.string().max(200).default(""),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (!ORIGINS.has(origin ?? "")) return Response.json({ error: "forbidden" }, { status: 403, headers });

  const { channelId } = await params;
  const [row] = await db
    .select({ channel: channels, agent: agents })
    .from(channels)
    .innerJoin(agents, eq(agents.id, channels.agentId))
    .where(and(eq(channels.id, channelId), eq(channels.type, "widget"), eq(channels.enabled, true)));
  if (!row) return Response.json({ error: "not_found" }, { status: 404, headers });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400, headers });
  const b = parsed.data;
  if (b.website) return Response.json({ ok: true }, { headers });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (tooMany(`l:${channelId}:${ip}`, PER_IP.limit, PER_IP.windowMs) || tooMany(`l:${channelId}`, PER_CHANNEL_HOUR, 60 * 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers });
  }

  const uk = b.lang === "uk";
  const text = [
    `📝 ${uk ? "Заявка з форми на сайті" : "Enquiry from the website form"}`,
    `${uk ? "Ім’я" : "Name"}: ${b.name}`,
    `${uk ? "Зв’язок" : "Contact"}: ${b.contact}`,
    b.need && `${uk ? "Що потрібно" : "What they need"}: ${b.need}`,
    b.page && `${uk ? "Сторінка" : "Page"}: ${b.page}`,
  ].filter(Boolean).join("\n");

  // Во «Входящие»: менеджер видит заявку рядом с чатами сайта; сбой здесь не мешает уведомлению.
  let conversationId: string | undefined;
  try {
    const { conversation } = await upsertConversation(row.channel, b.visitor, { name: b.name.slice(0, 60) });
    conversationId = conversation.id;
    await db
      .update(conversations)
      .set({ context: { ...conversation.context, language: b.lang, botContext: uk ? "Заявка з форми на сайті" : "Website form enquiry" } })
      .where(eq(conversations.id, conversation.id));
    await addMessage(conversation.id, "user", text);
  } catch (e) {
    console.error("lead inbox:", (e as Error).message);
  }

  await notifySiteLead({ name: b.name, contact: b.contact, need: b.need, page: b.page }, conversationId);
  return Response.json({ ok: true }, { headers });
}
