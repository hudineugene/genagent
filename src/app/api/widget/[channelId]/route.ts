import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, channels, conversations, type WidgetConfig, WIDGET_LANGS } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { addMessage, isTyping, listMessages, scheduleReply, upsertConversation } from "@/lib/conversations";

/**
 * Публичный API виджета (без авторизации): настройки, сообщения посетителя и отправка нового.
 * Посетитель опознаётся случайным id из localStorage окна виджета.
 */

const visitorSchema = z.string().uuid();

// Настройки кнопки читает скрипт на чужом сайте — разрешаем кросс-доменный GET.
const CORS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

async function loadChannel(channelId: string) {
  const [row] = await db
    .select({ channel: channels, agent: agents })
    .from(channels)
    .innerJoin(agents, eq(agents.id, channels.agentId))
    .where(and(eq(channels.id, channelId), eq(channels.type, "widget"), eq(channels.enabled, true)));
  return row;
}

export async function GET(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const row = await loadChannel(channelId);
  if (!row) return Response.json({ error: "not_found" }, { status: 404, headers: CORS });

  const url = new URL(req.url);
  const config = widgetView(row.channel.config as WidgetConfig, agentConfigSchema.safeParse(row.agent.config).data, url.searchParams.get("lang"));

  const visitor = visitorSchema.safeParse(url.searchParams.get("visitor"));
  if (!visitor.success) return Response.json({ config, messages: [], typing: false }, { headers: CORS });

  const [conv] = await db
    .select({ id: conversations.id, mode: conversations.mode })
    .from(conversations)
    .where(and(eq(conversations.channelId, channelId), eq(conversations.externalId, visitor.data)));
  if (!conv) return Response.json({ config, messages: [], typing: false }, { headers: CORS });

  const msgs = (await listMessages(conv.id, { afterId: url.searchParams.get("after") ?? undefined }))
    .filter((m) => m.role !== "system" && m.role !== "bot")
    .map((m) => ({ id: m.id, role: m.role === "user" ? "user" : "agent", text: m.text, at: m.createdAt }));
  return Response.json(
    { config, messages: msgs, typing: isTyping(conv.id), operator: conv.mode === "human" },
    { headers: CORS },
  );
}

// Простая защита от спама: не больше 20 сообщений в минуту с одного адреса в канал.
const hits = new Map<string, number[]>();
function rateLimited(key: string) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > 20;
}

const postSchema = z.object({
  visitor: visitorSchema,
  text: z.string().trim().min(1).max(4000),
  /** Язык страницы сайта (ru, uk, en, es…) — агент отвечает на нём */
  lang: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/).optional(),
  /** Какую страницу посетитель смотрит сейчас */
  page: z.object({ url: z.string().max(500).optional(), title: z.string().max(200).optional() }).optional(),
  /** Что сайт передал о странице: объект, цена, район (window.GenAgent.setContext или data-context) */
  context: z.string().max(1000).optional(),
});

/** Тексты окна на языке посетителя (если заданы), иначе — основные. */
function widgetView(cfg: WidgetConfig, agentCfg: { greeting?: string; icon?: string } | undefined, langRaw: string | null) {
  const lang = WIDGET_LANGS.find((l) => l === (langRaw ?? "").slice(0, 2).toLowerCase());
  const loc = lang ? cfg.locales?.[lang] : undefined;
  return {
    title: loc?.title || cfg.title,
    subtitle: loc?.subtitle || cfg.subtitle,
    color: cfg.color,
    position: cfg.position,
    telegramBot: cfg.telegramBot,
    greeting: loc?.greeting || agentCfg?.greeting || "",
    icon: agentCfg?.icon ?? "💬",
    quick: loc?.quick?.length ? loc.quick : (cfg.quick ?? []),
    teaser: loc?.teaser || cfg.teaser || "",
    teaserDelay: cfg.teaserDelay ?? 20,
  };
}

/** Что посетитель смотрит: страница и данные от сайта — агенту в контекст. */
function pageContext(page?: { url?: string; title?: string }, context?: string) {
  const lines = [
    page?.title || page?.url ? `Страница: ${[page.title, page.url].filter(Boolean).join(" — ")}` : "",
    context?.trim() ? context.trim() : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n").slice(0, 1500) : undefined;
}

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const row = await loadChannel(channelId);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(`${channelId}:${ip}`)) return Response.json({ error: "rate_limited" }, { status: 429 });

  const { conversation, created } = await upsertConversation(row.channel, parsed.data.visitor, {
    name: "",
    handle: "",
  });
  const { lang, page, context } = parsed.data;
  if (created) {
    // Приветствие видно посетителю до первого сообщения — сохраняем его в истории диалога (на языке страницы).
    const greeting = widgetView(row.channel.config as WidgetConfig, agentConfigSchema.safeParse(row.agent.config).data, lang ?? null).greeting.trim();
    if (greeting) await addMessage(conversation.id, "assistant", greeting);
  }
  // Язык и страница — в контекст разговора: агент ответит на языке сайта и знает, что посетитель смотрит
  const botContext = pageContext(page, context);
  if (lang || botContext) {
    await db
      .update(conversations)
      .set({ context: { ...conversation.context, ...(lang ? { language: lang } : {}), ...(botContext ? { botContext } : {}) } })
      .where(eq(conversations.id, conversation.id));
  }
  const m = await addMessage(conversation.id, "user", parsed.data.text);
  scheduleReply(conversation.id);
  return Response.json({ ok: true, id: m.id });
}
