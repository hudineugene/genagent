import { apiKey, withKeys } from "@/lib/keys";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, channels, conversations } from "@/db/schema";
import { addMessage, upsertConversation } from "@/lib/conversations";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * «Паспорт персонажа» для сайта студии: посетитель отвечает на 4 вопроса о бренде, модель составляет
 * карточку героя (имя, характер, голос, фразы, цвета). Ответы и паспорт попадают во «Входящие» канала
 * как готовый бриф — без ответа агента (посетитель не в чате).
 * Вызывается с сайта (другой домен), поэтому CORS — только для сайтов из ORIGINS, плюс ограничения частоты.
 */

const MODEL = "claude-sonnet-5-5";
const ORIGINS = new Set(["https://yabotua.com", "https://www.yabotua.com"]);
const PER_IP = { limit: 3, windowMs: 10 * 60_000 };
const PER_CHANNEL_HOUR = 60;

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

const text = (max: number) => z.string().trim().max(max);
const bodySchema = z.object({
  visitor: z.string().uuid(),
  lang: z.enum(["uk", "en"]).default("uk"),
  brand: text(120).min(1),
  about: text(500).default(""),
  traits: z.array(text(40).min(1)).max(4).default([]),
  traitOwn: text(100).default(""),
  audience: z.array(text(40).min(1)).max(8).default([]),
  audienceOwn: text(200).default(""),
  places: z.array(text(40).min(1)).max(8).default([]),
  /** Остальные вопросы анкеты сайта — «вопрос: ответ»; анкету можно менять на сайте, не трогая этот код */
  answers: z.array(z.object({ q: text(200).min(1), a: text(700).min(1) })).max(20).default([]),
});

type Passport = {
  name: string;
  emoji: string;
  archetype: string;
  look: string;
  traits: { title: string; text: string }[];
  voice: string;
  phrases: string[];
  colors: { hex: string; name: string }[];
  firstStep: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "emoji", "archetype", "look", "traits", "voice", "phrases", "colors", "firstStep"],
  properties: {
    name: { type: "string", description: "Имя персонажа: короткое, запоминающееся, легко произносится" },
    emoji: { type: "string", description: "Один эмодзи, который передаёт суть героя" },
    archetype: { type: "string", description: "Роль героя в 2–5 словах, например «Турботливий провідник у світі кави»" },
    look: { type: "string", description: "Как герой выглядит, одно-два предложения: форма, детали, фирменный элемент" },
    traits: {
      type: "array", description: "Ровно 3 черты характера: короткое название и пояснение",
      items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } },
    },
    voice: { type: "string", description: "Как говорит: тон, обращение, словечки — одно предложение" },
    phrases: { type: "array", items: { type: "string" }, description: "Ровно три фразы героя для соцсетей/упаковки/бота" },
    colors: {
      type: "array", description: "Ровно 3 цвета",
      items: { type: "object", additionalProperties: false, required: ["hex", "name"], properties: { hex: { type: "string", description: "HEX вида #RRGGBB" }, name: { type: "string" } } },
    },
    firstStep: { type: "string", description: "С чего начать: первый конкретный шаг запуска героя, одно предложение" },
  },
};

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

async function handle(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
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

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (tooMany(`p:${channelId}:${ip}`, PER_IP.limit, PER_IP.windowMs) || tooMany(`p:${channelId}`, PER_CHANNEL_HOUR, 60 * 60_000)) {
    return Response.json({ error: "rate_limited" }, { status: 429, headers });
  }

  const key = apiKey("anthropic");
  if (!key) return Response.json({ error: "unavailable" }, { status: 503, headers });

  const uk = b.lang === "uk";
  const brief = [
    `${uk ? "Бренд" : "Brand"}: ${b.brand}`,
    b.about && `${uk ? "Чим займається" : "What it does"}: ${b.about}`,
    (b.traits.length || b.traitOwn) && `${uk ? "Характер" : "Personality"}: ${[...b.traits, b.traitOwn].filter(Boolean).join(", ")}`,
    (b.audience.length || b.audienceOwn) && `${uk ? "Аудиторія" : "Audience"}: ${[...b.audience, b.audienceOwn].filter(Boolean).join(", ")}`,
    b.places.length && `${uk ? "Де житиме персонаж" : "Where the character will live"}: ${b.places.join(", ")}`,
    ...b.answers.map((x) => `${x.q}: ${x.a}`),
  ].filter(Boolean).join("\n").slice(0, 8000);

  const started = Date.now();
  let passport: Passport;
  try {
    const { data, usage, model } = await generateJson<Passport>(key, MODEL, {
      system: [
        "Ты — арт-директор студии YABOT (персонажи, стикеры, Telegram-решения для брендов, слоган «Design for Humans»).",
        "По брифу посетителя сайта составь «паспорт персонажа» — маскота его бренда. Это вдохновляющий черновик, а не финальный дизайн.",
        "Пиши живо, конкретно и с юмором, под этот бренд и аудиторию — без общих слов вроде «уникальный» и «инновационный».",
        "Не обещай сроков и цен, не упоминай конкурентов и чужие торговые марки, ничего не говори о самой студии.",
        "Опирайся на ВСЕ ответы брифа: миссию, ценности, эмоции, тип и стиль героя, тон, примеры. Связывай их в цельный образ, а не перечисляй.",
        "Если указано, каким герой НЕ должен быть, — строго соблюдай. Если указан тип или стиль героя — следуй ему; «не знаю» — предложи сам.",
        "Если в брифе есть что-то оскорбительное или неуместное — сделай доброго нейтрального героя для бренда.",
        "Цвета — гармоничная палитра для героя (HEX и короткое поэтичное название).",
        uk ? "Все тексты — на украинском языке." : "All texts in English.",
      ].join("\n"),
      prompt: `${uk ? "Бриф" : "Brief"}:\n${brief}`,
      schema: SCHEMA,
      effort: "low",
    });
    await logUsage({ source: "generate", model, usage, agentId: row.agent.id, clientId: row.channel.clientId, ms: Date.now() - started }).catch(() => {});
    passport = {
      name: clean(data.name, 40) || b.brand.slice(0, 40),
      emoji: clean(data.emoji, 8) || "✨",
      archetype: clean(data.archetype, 90),
      look: clean(data.look, 300),
      traits: (data.traits ?? []).slice(0, 3).map((t) => ({ title: clean(t.title, 40), text: clean(t.text, 160) })),
      voice: clean(data.voice, 220),
      phrases: (data.phrases ?? []).slice(0, 3).map((p) => clean(p, 140)),
      colors: (data.colors ?? []).slice(0, 3).filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex)).map((c) => ({ hex: c.hex.toUpperCase(), name: clean(c.name, 30) })),
      firstStep: clean(data.firstStep, 220),
    };
  } catch (e) {
    console.error("passport:", (e as Error).message);
    return Response.json({ error: "failed" }, { status: 502, headers });
  }

  // Во «Входящие»: ответы посетителя (бриф) и паспорт — менеджер видит заявку и может написать первым, если посетитель продолжит в чате.
  try {
    const { conversation } = await upsertConversation(row.channel, b.visitor, { name: b.brand.slice(0, 60) });
    await db
      .update(conversations)
      .set({ context: { ...conversation.context, language: b.lang, botContext: uk ? "Паспорт персонажа з сайту" : "Character passport from the website" } })
      .where(eq(conversations.id, conversation.id));
    await addMessage(conversation.id, "user", `📋 ${uk ? "Паспорт персонажа — відповіді з сайту" : "Character passport — answers from the website"}\n${brief}`);
    const card = [
      `${passport.emoji} ${passport.name} — ${passport.archetype}`,
      passport.look,
      ...passport.traits.map((t) => `• ${t.title}: ${t.text}`),
      `${uk ? "Голос" : "Voice"}: ${passport.voice}`,
      ...passport.phrases.map((p) => `«${p}»`),
      `${uk ? "Кольори" : "Colours"}: ${passport.colors.map((c) => `${c.name} ${c.hex}`).join(", ")}`,
      `${uk ? "Перший крок" : "First step"}: ${passport.firstStep}`,
    ].join("\n");
    await addMessage(conversation.id, "system", card);
  } catch (e) {
    console.error("passport inbox:", (e as Error).message);
  }

  return Response.json({ passport }, { headers });
}

/** Всё, что делается по запросу канала, — в области ключей клиента этого канала. */
export async function POST(req: Request, ctx: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await ctx.params;
  const [ch] = await db.select({ clientId: channels.clientId }).from(channels).where(eq(channels.id, channelId));
  return withKeys({ clientId: ch?.clientId }, () => handle(req, { params: Promise.resolve({ channelId }) }));
}
