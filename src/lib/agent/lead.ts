import "server-only";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
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
  const { data, usage, model } = await generateJson<{ temperature: LeadCard["temperature"]; reason: string; fields: { label: string; value: string }[]; test: boolean }>(key, MODEL, {
    system: [
      `Ты помогаешь менеджеру компании быстро понять клиента по переписке с консультантом (${cfg.role || "консультант"}).`,
      `Заполни карточку: поля — ${fields}. Пиши только то, что клиент сам сказал или явно подтвердил; чего нет — не включай поле. Значения коротко, по-русски (до 12 слов). «Контакт» — только способ связи, который клиент оставил (телефон, почта, «пишите сюда»), без самих цифр, если их нет в переписке.`,
      "temperature: hot — клиент готов к шагу: оставил контакт, просит звонок, просмотр, встречу, счёт или заказ, спрашивает про оплату или резерв конкретного товара/объекта; warm — конкретный интерес с параметрами (бюджет, что именно, когда), но шага ещё нет; cold — общий вопрос, справка, болтовня, тест или вопрос не по делу.",
      "reason — одна короткая фраза, почему такая оценка (что сказал клиент).",
      "test — true, только если переписка явно проверка бота, а не настоящий клиент: человек сам пишет, что тестирует или проверяет бота, называет себя разработчиком или сотрудником, шлёт заведомо абсурдные запросы ради проверки. Иначе false.",
    ].join("\n"),
    prompt: `Переписка:\n${dialog
      .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Консультант"}: ${m.text.replace(/\s+/g, " ").slice(0, 500)}`)
      .join("\n")}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["temperature", "reason", "fields", "test"],
      properties: {
        temperature: { type: "string", enum: ["hot", "warm", "cold"] },
        test: { type: "boolean" },
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
    ...(data.test ? { looksTest: true } : {}),
    at: Date.now(),
    upto: dialog.at(-1)?.createdAt.getTime() ?? Date.now(),
  };
  // Свежий контекст: пока модель думала, могли дописаться язык, память, заказы
  const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, c.id));
  await db.update(conversations).set({ context: { ...cur?.context, lead } }).where(eq(conversations.id, c.id));
  // Карточка изменилась — во внешние системы клиента (Google Таблица, вебхук); одинаковую повторно не шлём
  const prev = cur?.context?.lead;
  const sig = (l?: LeadCard) => (l ? JSON.stringify([l.temperature, l.fields]) : "");
  if (sig(prev) !== sig(lead)) {
    void import("@/lib/integrations/events").then((m) => m.emitEvent("lead", { clientId: c.clientId, agentId: c.agentId, conversationId: c.id, lead }));
  }
  if (lead.temperature === "hot") await hotAlert(c.id).catch((e) => console.error("hot lead alert failed", c.id, e));
  return lead;
}

/** Рабочие часы студии (как у напоминаний «клиент ждёт человека»), по Киеву. */
async function inWorkHours(now = new Date()) {
  const { getWaitingSettings } = await import("./waiting");
  const s = await getWaitingSettings();
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hourCycle: "h23" }).format(now));
  return s.fromHour <= s.toHour ? hour >= s.fromHour && hour < s.toHour : hour >= s.fromHour || hour < s.toHour;
}

/**
 * Клиент стал горячим, а менеджер о нём ещё не знает — сразу сообщить в Telegram («🔥 горячий клиент сейчас в чате»).
 * Один раз на разговор; не тестовые; не тем, кого уже передали менеджеру, кто у менеджера или кому менеджер писал.
 * Вне рабочих часов — откладываем до их начала. Возвращает true, если отправлено.
 */
export async function hotAlert(conversationId: string): Promise<boolean> {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!c || c.isTest || c.status === "closed" || c.context?.lead?.temperature !== "hot" || c.context.lead.looksTest || c.context?.hotAlertAt) return false;
  const [known] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, c.id), sql`(${messages.role} = 'operator' or (${messages.role} = 'system' and ${messages.text} = 'handoff'))`))
    .limit(1);
  const save = async (patch: { hotAlertAt?: number; hotAlertPending?: boolean }) => {
    const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, c.id));
    await db.update(conversations).set({ context: { ...cur?.context, ...patch } }).where(eq(conversations.id, c.id));
  };
  // Менеджер уже в курсе — оповещать не о чем
  if (known || c.mode === "human" || c.needsAttention) {
    if (c.context?.hotAlertPending) await save({ hotAlertPending: false });
    return false;
  }
  if (!(await inWorkHours())) {
    if (!c.context?.hotAlertPending) await save({ hotAlertPending: true });
    return false;
  }
  await save({ hotAlertAt: Date.now(), hotAlertPending: false });
  const { notifyHotLead } = await import("@/lib/notify/telegram");
  await notifyHotLead(c.id, c.context.lead);
  return true;
}

/** Отложенные ночью оповещения — в рабочие часы. */
export async function flushHotAlerts() {
  if (!(await inWorkHours())) return 0;
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(sql`json_extract(${conversations.context}, '$.hotAlertPending') = 1`);
  let n = 0;
  for (const r of rows) if (await hotAlert(r.id).catch(() => false)) n++;
  return n;
}

/** Обновить карточки разговоров, где клиент написал новое и затем помолчал QUIET_MS. Возвращает число обновлённых. */
export async function runLeads(): Promise<number> {
  await flushHotAlerts().catch((e) => console.error("hot lead alerts failed", e));
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
