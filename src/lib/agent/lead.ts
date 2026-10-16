import "server-only";
import { and, asc, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { agents, conversations, messages, type LeadCard } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Карточка лида: дешёвая модель по переписке заполняет, что клиент хочет (поля задаются в агенте — бюджет, спальни,
 * район, сроки…), и оценивает «горячесть»: горячий — готов к шагу (оставил контакт, просит звонок, просмотр, заказ),
 * тёплый — конкретный интерес и параметры, холодный — общий вопрос. Менеджер видит карточку в «Диалогах», в
 * уведомлении о передаче и в утренней сводке лидов (горячие первыми). Только то, что клиент сам сказал.
 */
const MODEL = "claude-haiku-5-5";
const QUIET_MS = 3 * 60 * 1000;
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const PER_RUN = 30;
export const DEFAULT_LEAD_FIELDS = "Что ищет, Бюджет, Сроки, Контакт";

/** Обновить карточку лида разговора. null — нечего оценивать (клиент почти ничего не написал). */
export async function updateLead(conversationId: string): Promise<LeadCard | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  const [row] = await db
    .select({ conversation: conversations, agentConfig: agents.config })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(eq(conversations.id, conversationId));
  if (!key || !row || row.conversation.kind !== "dm") return null;
  const c = row.conversation;
  const cfg = row.agentConfig as { leadFields?: string; role?: string };
  const rows = await db
    .select({ role: messages.role, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, c.id), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"])))
    .orderBy(desc(messages.createdAt))
    .limit(60);
  const dialog = rows.reverse();
  if (dialog.filter((m) => m.role === "user" && m.text.trim().length >= 2).length < 1) return null;
  const fields = (cfg.leadFields?.trim() || DEFAULT_LEAD_FIELDS).slice(0, 400);
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ temperature: LeadCard["temperature"]; reason: string; fields: { label: string; value: string }[] }>(key, MODEL, {
    system: [
      `Ты помогаешь менеджеру компании быстро понять клиента по переписке с консультантом (${cfg.role || "консультант"}).`,
      `Заполни карточку: поля — ${fields}. Пиши только то, что клиент сам сказал или явно подтвердил; чего нет — не включай поле. Значения коротко, по-русски (до 12 слов). «Контакт» — только способ связи, который клиент оставил (телефон, почта, «пишите сюда»), без самих цифр, если их нет в переписке.`,
      "temperature: hot — клиент готов к шагу: оставил контакт, просит звонок, просмотр, встречу, счёт или заказ, спрашивает про оплату или резерв конкретного товара/объекта; warm — конкретный интерес с параметрами (бюджет, что именно, когда), но шага ещё нет; cold — общий вопрос, справка, болтовня, тест или вопрос не по делу.",
      "reason — одна короткая фраза, почему такая оценка (что сказал клиент).",
    ].join("\n"),
    prompt: `Переписка:\n${dialog
      .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Консультант"}: ${m.text.replace(/\s+/g, " ").slice(0, 500)}`)
      .join("\n")}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["temperature", "reason", "fields"],
      properties: {
        temperature: { type: "string", enum: ["hot", "warm", "cold"] },
        reason: { type: "string" },
        fields: {
          type: "array",
          items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } },
        },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId: c.agentId, clientId: c.clientId, conversationId: c.id, ms: Date.now() - started }).catch(() => {});
  const lead: LeadCard = {
    temperature: ["hot", "warm", "cold"].includes(data.temperature) ? data.temperature : "cold",
    reason: data.reason.trim().slice(0, 200),
    fields: data.fields
      .map((f) => ({ label: f.label.trim().slice(0, 40), value: f.value.trim().slice(0, 160) }))
      .filter((f) => f.label && f.value)
      .slice(0, 8),
    at: Date.now(),
    upto: dialog.at(-1)?.createdAt.getTime() ?? Date.now(),
  };
  // Свежий контекст: пока модель думала, могли дописаться язык, память, заказы
  const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, c.id));
  await db.update(conversations).set({ context: { ...cur?.context, lead } }).where(eq(conversations.id, c.id));
  return lead;
}

/** Обновить карточки разговоров, где клиент написал новое и затем помолчал QUIET_MS. Возвращает число обновлённых. */
export async function runLeads(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) return 0;
  const now = Date.now();
  const rows = await db
    .select({ id: conversations.id, lastMessageAt: conversations.lastMessageAt, context: conversations.context, agentStatus: agents.status })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(and(eq(conversations.kind, "dm"), gt(conversations.lastMessageAt, new Date(now - LOOKBACK_MS)), lt(conversations.lastMessageAt, new Date(now - QUIET_MS))))
    .orderBy(asc(conversations.lastMessageAt))
    .limit(300);
  let done = 0;
  for (const r of rows) {
    if (done >= PER_RUN) break;
    if (r.agentStatus !== "active") continue;
    if (r.lastMessageAt.getTime() <= (r.context?.lead?.upto ?? 0)) continue;
    try {
      // null — клиент ещё ничего по делу не написал (модель не вызывалась)
      if (await updateLead(r.id)) done++;
    } catch (e) {
      console.error("lead card failed", r.id, e);
    }
  }
  return done;
}

export const LEAD_ICON: Record<LeadCard["temperature"], string> = { hot: "🔥", warm: "🌤", cold: "❄️" };

export function startLeads() {
  const g = globalThis as unknown as { __leadsCardTimer?: ReturnType<typeof setInterval> };
  if (g.__leadsCardTimer) return;
  const run = () => void runLeads().catch((e) => console.error("lead cards failed", e));
  setTimeout(run, 4 * 60_000).unref?.();
  g.__leadsCardTimer = setInterval(run, 5 * 60_000);
  g.__leadsCardTimer.unref?.();
}
