import "server-only";
import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { agents, conversations, messages, type ClientMemory } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Долгая память о клиенте. Агент видит последние 40 сообщений, а клиент возвращается через неделю-месяц —
 * и хочет, чтобы его помнили. Раз в 10 минут: личные разговоры, которые затихли (30 мин без сообщений)
 * и где появилось новое с прошлого раза, — дешёвая модель сливает прежние факты о клиенте с новой
 * перепиской: до 12 коротких пунктов (как зовут, что заказывал и любит, о чём просил, что не понравилось).
 * Без телефонов, номеров карт, документов, адресов и диагнозов. Агент видит их в «Что ты помнишь о клиенте»;
 * в «Диалогах» их можно посмотреть и стереть («Забыть»). У агента — переключатель config.memory.
 */
const MODEL = "claude-haiku-5-5";
const QUIET_MS = 30 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const PER_RUN = 30;
const MAX_FACTS = 12;
const MAX_FACT_LEN = 160;

export function memoryNote(memory: ClientMemory | undefined): string | undefined {
  const facts = memory?.facts?.filter(Boolean) ?? [];
  if (!facts.length) return undefined;
  return [
    "# Что ты помнишь о клиенте (из прошлых разговоров)",
    "Пользуйся этим естественно, как человек, который помнит постоянного клиента: обратись по имени, вспомни прошлый заказ или просьбу, когда это к месту. Не перечисляй всё подряд и не говори «согласно моим записям». Если клиент сейчас говорит иначе — верь клиенту.",
    ...facts.map((f) => `- ${f}`),
  ].join("\n");
}

function clean(facts: unknown): string[] {
  if (!Array.isArray(facts)) return [];
  const out: string[] = [];
  for (const f of facts) {
    const s = String(f ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LEN);
    if (s.length >= 3 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, MAX_FACTS);
}

/** Возвращает, сколько разговоров обновили. dryRun — только отобрать (без модели и без записи). */
export async function runMemory({ dryRun = false }: { dryRun?: boolean } = {}): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key && !dryRun) return 0;
  const now = Date.now();
  const rows = await db
    .select({ conversation: conversations, agentConfig: agents.config, agentStatus: agents.status })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    // тестовые разговоры — не запоминаем
    .where(and(eq(conversations.kind, "dm"), eq(conversations.isTest, false), gt(conversations.lastMessageAt, new Date(now - LOOKBACK_MS)), lt(conversations.lastMessageAt, new Date(now - QUIET_MS))))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(300);
  let done = 0;
  for (const { conversation: c, agentConfig, agentStatus } of rows) {
    if (done >= PER_RUN) break;
    if (agentStatus !== "active" || (agentConfig as { memory?: boolean }).memory === false) continue;
    const upto = c.context?.memory?.upto ?? 0;
    if (c.lastMessageAt.getTime() <= upto) continue;
    const fresh = await db
      .select({ role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, c.id),
          eq(messages.status, "sent"),
          inArray(messages.role, ["user", "assistant", "operator"]),
          gt(messages.createdAt, new Date(upto)),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(200);
    const dialog = fresh.slice(-60);
    const last = fresh.at(-1)?.createdAt.getTime() ?? c.lastMessageAt.getTime();
    const said = dialog.some((m) => m.role === "user" && (m.text.trim().length >= 2 || m.meta?.vision));
    if (dryRun) {
      if (said) done++;
      continue;
    }
    const old = c.context?.memory?.facts ?? [];
    let facts = old;
    if (said) {
      const started = Date.now();
      try {
        const { data, usage, model } = await generateJson<{ facts: string[] }>(key, MODEL, {
          system: [
            "Ты ведёшь короткую память консультанта о постоянном клиенте компании: то, что пригодится в следующем разговоре через неделю или месяц.",
            `Слей прежние факты с новой перепиской в список до ${MAX_FACTS} пунктов, каждый — одна короткая фраза (до 15 слов) на русском.`,
            "Что записывать: как зовут и как просил обращаться; что заказывал или выбирал, что понравилось и что нет; предпочтения (стиль, бюджет, район, удобное время, язык); важные детали (питомец, для кого покупка, повод); о чём просил и что ему обещали; недовольство и его причина.",
            "Не записывай: телефоны, почту, адреса, номера карт и документов, платёжные данные, диагнозы и подробности о здоровье (можно — что интересовался таким-то препаратом), пересказ ответов консультанта, общие вопросы без личного (часы работы, цены).",
            "Новое важнее старого: если клиент передумал — замени факт. Устаревшее и мелкое убирай. Если запомнить нечего — верни прежние факты.",
          ].join("\n"),
          prompt: [
            old.length ? `Прежние факты:\n${old.map((f) => `- ${f}`).join("\n")}` : "Прежних фактов нет.",
            `Новая переписка:\n${dialog
              .map((m) => {
                const who = m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Консультант";
                const photo = m.meta?.vision ? ` [прислал фото: ${m.meta.vision.slice(0, 200)}]` : "";
                return `${who}: ${m.text.slice(0, 500)}${photo}`;
              })
              .join("\n")}`,
          ].join("\n\n"),
          schema: { type: "object", additionalProperties: false, required: ["facts"], properties: { facts: { type: "array", items: { type: "string" } } } },
          effort: "low",
        });
        await logUsage({ source: "insights", model, usage, agentId: c.agentId, clientId: c.clientId, conversationId: c.id, ms: Date.now() - started }).catch(() => {});
        facts = clean(data.facts);
      } catch (e) {
        console.error("client memory failed", c.id, e);
        continue; // попробуем в следующий раз
      }
    }
    // Свежий контекст: пока модель думала, бот мог дописать язык, заказы…
    const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, c.id));
    await db
      .update(conversations)
      .set({ context: { ...cur?.context, memory: { facts, at: now, upto: last } } })
      .where(eq(conversations.id, c.id));
    if (said) done++;
  }
  return done;
}

/** «Забыть»: стереть факты; то, что было до этого момента, заново не запоминаем. */
export async function forgetClient(conversationId: string) {
  const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversationId));
  if (!cur) return;
  const now = Date.now();
  await db.update(conversations).set({ context: { ...cur.context, memory: { facts: [], at: now, upto: now } } }).where(eq(conversations.id, conversationId));
}

export function startMemory() {
  const g = globalThis as unknown as { __memoryTimer?: ReturnType<typeof setInterval> };
  if (g.__memoryTimer) return;
  const run = () => void runMemory().catch((e) => console.error("client memory run failed", e));
  setTimeout(run, 5 * 60_000).unref?.();
  g.__memoryTimer = setInterval(run, 10 * 60_000);
  g.__memoryTimer.unref?.();
}
