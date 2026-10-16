import "server-only";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, agents, channels, clients, conversations, messages, type ApiConfig } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Напоминания тем, кто поговорил с агентом и ушёл ни с чем. Раз в час: разговоры в каналах «Свой бот»
 * с включёнными напоминаниями, где клиент писал последний раз 20–48 часов назад, агент ответил последним,
 * не было передачи менеджеру, менеджер не ведёт диалог, и после разговора не было события-результата
 * (бриф, заявка, просмотр…). Дешёвая модель пишет одно короткое личное сообщение по теме разговора —
 * оно встаёт в очередь /outbox (kind: followup), бот отправляет его своим именем по своим правилам.
 * Не чаще раза в неделю на человека.
 */
const MODEL = "claude-haiku-5-5";
const MIN_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const REPEAT_MS = 7 * 24 * 60 * 60 * 1000;
const PER_RUN = 20;
const NOT_RESULTS = new Set(["rating_up", "rating_down", "followup_sent", "brief_started"]);

const LANGS: Record<string, string> = { ru: "русский", uk: "українська", en: "English", es: "español" };

/** dryRun — только отобрать, кому напомнить (без модели и без записи): для проверки. Возвращает число напоминаний (или кандидатов). */
export async function runFollowUps({ dryRun = false }: { dryRun?: boolean } = {}): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key && !dryRun) return 0;
  const apiChannels = (await db.select().from(channels).where(and(eq(channels.type, "api"), eq(channels.enabled, true)))).filter(
    (c) => (c.config as ApiConfig).followUps,
  );
  let made = 0;
  for (const ch of apiChannels) {
    const [agent] = await db
      .select({ id: agents.id, status: agents.status, config: agents.config, client: clients.name })
      .from(agents)
      .innerJoin(clients, eq(clients.id, agents.clientId))
      .where(eq(agents.id, ch.agentId));
    if (!agent || agent.status !== "active") continue;
    const now = Date.now();
    const candidates = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.channelId, ch.id),
          eq(conversations.kind, "dm"),
          eq(conversations.mode, "ai"),
          eq(conversations.isTest, false), // тестовым разговорам не напоминаем
          gt(conversations.lastMessageAt, new Date(now - MAX_AGE_MS)),
          lt(conversations.lastMessageAt, new Date(now - MIN_AGE_MS)),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(100);
    for (const c of candidates) {
      if (made >= PER_RUN) return made;
      if (c.context?.followUpAt && now - c.context.followUpAt < REPEAT_MS) continue;
      const msgs = await db
        .select({ role: messages.role, text: messages.text, status: messages.status, meta: messages.meta, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.conversationId, c.id))
        .orderBy(desc(messages.createdAt))
        .limit(30);
      const sent = msgs.filter((m) => m.status === "sent");
      const lastUser = sent.find((m) => m.role === "user");
      if (!lastUser || now - lastUser.createdAt.getTime() < MIN_AGE_MS || now - lastUser.createdAt.getTime() > MAX_AGE_MS) continue;
      if (sent[0]?.role !== "assistant" || sent[0].meta?.followUp) continue; // агент ответил последним, и это не напоминание
      if (sent.some((m) => (m.role === "system" && m.text === "handoff") || m.role === "operator")) continue;
      // После разговора клиент уже что-то сделал (бриф, заявка, просмотр…) — напоминать не о чем.
      const results = await db
        .select({ type: agentEvents.type })
        .from(agentEvents)
        .where(and(eq(agentEvents.channelId, ch.id), eq(agentEvents.externalUserId, c.externalId), gt(agentEvents.createdAt, new Date(lastUser.createdAt.getTime() - 60_000))))
        .limit(20);
      if (results.some((r) => !NOT_RESULTS.has(r.type))) continue;

      if (dryRun) {
        made++;
        continue;
      }
      const dialog = [...sent].reverse().filter((m) => m.role === "user" || m.role === "assistant").slice(-12);
      const lang = LANGS[c.context?.language ?? ""] ?? null;
      const cfg = agent.config as { replyLanguage?: string; toneCustom?: string };
      const started = Date.now();
      try {
        const { data, usage, model } = await generateJson<{ send: boolean; text: string }>(key, MODEL, {
          system: [
            `Ты пишешь одно короткое напоминание от компании «${agent.client}» клиенту, который вчера переписывался с консультантом и не дошёл до следующего шага.`,
            "1–2 предложения, тепло и без давления: вспомни, о чём он спрашивал, и предложи один понятный следующий шаг (кнопки бота можно называть). Не повторяй цены и факты, которых нет в переписке. Без markdown, максимум одно эмодзи.",
            lang ? `Язык: ${lang}.` : cfg.replyLanguage && cfg.replyLanguage !== "auto" ? `Язык: ${LANGS[cfg.replyLanguage] ?? cfg.replyLanguage}.` : "Язык — тот, на котором писал клиент.",
            cfg.toneCustom ? `Тон компании: ${cfg.toneCustom}` : "",
            (ch.config as ApiConfig).botNote ? `Что есть в боте: ${(ch.config as ApiConfig).botNote}` : "",
            "send=false, если напоминание неуместно: клиент получил полный ответ и ничего не собирался делать, разговор был не по теме, клиент недоволен или просил не писать.",
          ]
            .filter(Boolean)
            .join("\n"),
          prompt: dialog.map((m) => `${m.role === "user" ? "Клиент" : "Консультант"}: ${m.text.slice(0, 800)}`).join("\n"),
          schema: { type: "object", additionalProperties: false, required: ["send", "text"], properties: { send: { type: "boolean" }, text: { type: "string" } } },
          effort: "low",
        });
        await logUsage({ source: "insights", model, usage, agentId: agent.id, clientId: ch.clientId, conversationId: c.id, ms: Date.now() - started }).catch(() => {});
        await db.update(conversations).set({ context: { ...c.context, followUpAt: now } }).where(eq(conversations.id, c.id));
        const text = data.text.trim();
        if (!data.send || text.length < 5) continue;
        await db.insert(messages).values({
          conversationId: c.id,
          role: "assistant",
          text: text.slice(0, 1000),
          status: "sent",
          meta: { model, followUp: true },
        });
        made++;
      } catch (e) {
        console.error("follow-up failed", c.id, e);
      }
    }
  }
  return made;
}

export function startFollowUps() {
  const g = globalThis as unknown as { __followTimer?: ReturnType<typeof setInterval> };
  if (g.__followTimer) return;
  const run = () => void runFollowUps().catch((e) => console.error("follow-ups failed", e));
  setTimeout(run, 7 * 60_000).unref?.();
  g.__followTimer = setInterval(run, 60 * 60_000);
  g.__followTimer.unref?.();
}
