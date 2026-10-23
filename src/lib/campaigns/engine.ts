import "server-only";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  bookings,
  campaignRuns,
  campaigns,
  channels,
  conversations,
  messages,
  type Campaign,
  type CampaignRun,
  type CampaignSegment,
  type CampaignStep,
} from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Рассылки и цепочки. Раз в минуту: цепочки набирают новых участников (события после включения), сообщения,
 * у которых подошло время, отправляются — в Telegram, почту и WhatsApp напрямую, в свой бот клиента — через очередь
 * напоминаний (бот применяет свои проверки). Ночью (21:00–9:00 по Киеву) не пишем — переносим на утро.
 * WhatsApp и Instagram — только в течение 24 часов после последнего сообщения клиента (правило площадок).
 * Цепочка останавливается, если клиент ответил; «стоп» отписывает от всех рассылок клиента.
 */
const MODEL = "claude-haiku-5-5";
const PER_TICK = 30;
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Каналы, куда можно написать первым */
export const PUSH_CHANNELS = ["telegram", "api", "email", "whatsapp", "instagram"];
const OPT_OUT_RE = /^\s*(стоп|stop|отписаться|відписатися|отписка|unsubscribe)\s*[.!]?\s*$/i;

export const isOptOut = (text: string) => OPT_OUT_RE.test(text);

const OPT_OUT_HINT: Record<string, string> = {
  ru: "Чтобы не получать такие сообщения, напишите «стоп».",
  uk: "Щоб не отримувати такі повідомлення, напишіть «стоп».",
  en: "Reply “stop” to unsubscribe.",
  es: "Responda «stop» para no recibir más mensajes.",
};

export type Candidate = {
  id: string;
  agentId: string;
  channelId: string;
  channelType: string;
  contactName: string;
  lastUserAt: number | null;
  temperature: string | null;
};

/** Разговоры клиента, подходящие под сегмент (тестовые, отписавшиеся и каналы без отправки первыми — исключены). */
export async function matchSegment(clientId: string, seg: CampaignSegment): Promise<Candidate[]> {
  const rows = await db
    .select({ c: conversations, channelType: channels.type })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(and(eq(conversations.clientId, clientId), eq(conversations.isTest, false), eq(conversations.kind, "dm")));
  const list = rows.filter(
    ({ c, channelType }) =>
      PUSH_CHANNELS.includes(channelType) &&
      !c.context?.optOut &&
      (!seg.agentIds?.length || seg.agentIds.includes(c.agentId)) &&
      (!seg.channelTypes?.length || seg.channelTypes.includes(channelType)) &&
      (!seg.temperature?.length || (c.context?.lead && seg.temperature.includes(c.context.lead.temperature))),
  );
  if (!list.length) return [];
  const ids = list.map((r) => r.c.id);
  const last = new Map(
    (
      await db
        .select({ id: messages.conversationId, at: sql<number>`max(${messages.createdAt})` })
        .from(messages)
        .where(and(inArray(messages.conversationId, ids), eq(messages.role, "user")))
        .groupBy(messages.conversationId)
    ).map((r) => [r.id, Number(r.at)]),
  );
  const handoffs = seg.hadHandoff
    ? new Set(
        (await db.select({ id: messages.conversationId }).from(messages).where(and(inArray(messages.conversationId, ids), eq(messages.role, "system"), eq(messages.text, "handoff")))).map((r) => r.id),
      )
    : null;
  const word = seg.contains?.trim().toLowerCase();
  const now = Date.now();
  return list
    .filter(({ c }) => {
      const at = last.get(c.id);
      if (!at) return false;
      if (seg.activeWithinDays && now - at > seg.activeWithinDays * 86400_000) return false;
      if (seg.inactiveForDays && now - at < seg.inactiveForDays * 86400_000) return false;
      if (handoffs && !handoffs.has(c.id)) return false;
      if (word) {
        const hay = [c.contactName, c.contactHandle, ...(c.context?.lead?.fields ?? []).map((f) => `${f.label} ${f.value}`)].join(" ").toLowerCase();
        if (!hay.includes(word)) return false;
      }
      return true;
    })
    .map(({ c, channelType }) => ({
      id: c.id,
      agentId: c.agentId,
      channelId: c.channelId,
      channelType,
      contactName: c.contactName,
      lastUserAt: last.get(c.id) ?? null,
      temperature: c.context?.lead?.temperature ?? null,
    }));
}

/** Тихие часы: 21:00–9:00 по Киеву → ближайшие 9:00. Возвращает null, если писать можно сейчас. */
export function quietUntil(now = new Date()): Date | null {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour >= 9 && hour < 21) return null;
  const hoursTo9 = hour >= 21 ? 24 - hour + 9 : 9 - hour;
  const minutes = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", minute: "2-digit" }).format(now));
  return new Date(now.getTime() + hoursTo9 * 3600_000 - minutes * 60_000);
}

/** Запустить рассылку: найти получателей сейчас и поставить им сообщение (сразу или ко времени). */
export async function launchBroadcast(campaignId: string) {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c || c.kind !== "broadcast" || !c.steps.length) return 0;
  const list = await matchSegment(c.clientId, c.segment);
  const due = c.scheduleAt && c.scheduleAt.getTime() > Date.now() ? c.scheduleAt : new Date();
  for (const x of list) {
    await db.insert(campaignRuns).values({ campaignId: c.id, conversationId: x.id, dueAt: due, enrolledAt: new Date() }).onConflictDoNothing();
  }
  await db.update(campaigns).set({ enabled: true, enabledAt: new Date(), status: due.getTime() > Date.now() ? "scheduled" : "sending", updatedAt: new Date() }).where(eq(campaigns.id, c.id));
  return list.length;
}

/** Когда наступило событие запуска цепочки для разговора (мс) — или null. */
async function triggerAt(c: Campaign, conversationId: string, lead: { temperature: string; at: number } | undefined): Promise<number | null> {
  const since = c.enabledAt?.getTime() ?? Date.now();
  switch (c.trigger) {
    case "idle": {
      const recent = await db
        .select({ role: messages.role, text: messages.text, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator", "system"])))
        .orderBy(desc(messages.createdAt))
        .limit(10);
      const lastUser = recent.find((m) => m.role === "user");
      if (!lastUser || lastUser.createdAt.getTime() < since) return null;
      // агент ответил последним, передачи после этого не было
      const after = recent.filter((m) => m.createdAt >= lastUser.createdAt && m.role !== "user");
      if (!after.some((m) => m.role === "assistant") || after.some((m) => m.role === "operator" || (m.role === "system" && m.text === "handoff"))) return null;
      return lastUser.createdAt.getTime();
    }
    case "handoff": {
      const [m] = await db
        .select({ at: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "system"), eq(messages.text, "handoff"), gt(messages.createdAt, new Date(since))))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return m ? m.at.getTime() : null;
    }
    case "booking": {
      const [b] = await db
        .select({ at: bookings.createdAt })
        .from(bookings)
        .where(and(eq(bookings.conversationId, conversationId), gt(bookings.createdAt, new Date(since))))
        .orderBy(desc(bookings.createdAt))
        .limit(1);
      return b ? b.at.getTime() : null;
    }
    case "hot":
      return lead?.temperature === "hot" && lead.at > since ? lead.at : null;
    default:
      return null;
  }
}

/** Цепочки набирают участников: событие запуска после включения → первый шаг через паузу. */
export async function enrollSequences(): Promise<number> {
  const list = await db.select().from(campaigns).where(and(eq(campaigns.kind, "sequence"), eq(campaigns.enabled, true)));
  let added = 0;
  for (const c of list) {
    if (!c.steps.length || !c.trigger) continue;
    const enrolled = new Set((await db.select({ id: campaignRuns.conversationId }).from(campaignRuns).where(eq(campaignRuns.campaignId, c.id))).map((r) => r.id));
    for (const x of await matchSegment(c.clientId, c.segment)) {
      if (enrolled.has(x.id)) continue;
      const [conv] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, x.id));
      const at = await triggerAt(c, x.id, conv?.context?.lead);
      if (!at) continue;
      await db
        .insert(campaignRuns)
        .values({ campaignId: c.id, conversationId: x.id, dueAt: new Date(at + c.steps[0].delayHours * 3600_000), enrolledAt: new Date(at) })
        .onConflictDoNothing();
      added++;
    }
  }
  return added;
}

const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? "";

/** Текст шага: шаблон с {name} или личное сообщение от ИИ по разговору (может решить не писать). */
async function compose(c: Campaign, step: CampaignStep, conversationId: string): Promise<{ text: string } | { skip: string }> {
  const [row] = await db
    .select({ conv: conversations, agent: agents })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(eq(conversations.id, conversationId));
  if (!row) return { skip: "not_found" };
  const lang = row.conv.context?.language ?? "ru";
  const hint = c.options.optOutHint ? `\n\n${OPT_OUT_HINT[lang] ?? OPT_OUT_HINT.ru}` : "";
  if (step.mode === "text") {
    const name = firstName(row.conv.contactName);
    const text = step.text.replace(/\{name\}/g, name).replace(/\s+([,!?.])/g, "$1").trim();
    return { text: text + hint };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { skip: "no_key" };
  const dialog = (
    await db
      .select({ role: messages.role, text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"])))
      .orderBy(desc(messages.createdAt))
      .limit(12)
  )
    .reverse()
    .map((m) => `${m.role === "user" ? "Клиент" : "Компания"}: ${m.text.slice(0, 600)}`)
    .join("\n");
  const cfg = row.agent.config as { role?: string; rules?: string; tone?: string };
  const lead = row.conv.context?.lead;
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ send: boolean; text: string }>(apiKey, MODEL, {
    system: [
      `Ты пишешь клиенту первым от имени компании (${cfg.role || "консультант"}). Задание на это сообщение даёт владелец ниже.`,
      "Одно короткое личное сообщение (1–3 предложения) по теме прошлого разговора и задания, на языке клиента, без markdown, без давления и выдуманных фактов, скидок и сроков.",
      "send=false — если писать неуместно (клиент просил не писать, разговор не о том, задание к нему не подходит).",
      `Правила компании: ${cfg.rules?.slice(0, 2000) || "—"}`,
    ].join("\n"),
    prompt: `Задание: ${step.text}\n\nКлиент: ${row.conv.contactName || "—"}${lead ? `\nКарточка: ${lead.fields.map((f) => `${f.label}: ${f.value}`).join("; ")}` : ""}\n\nПрошлый разговор:\n${dialog || "—"}`,
    schema: { type: "object", additionalProperties: false, required: ["send", "text"], properties: { send: { type: "boolean" }, text: { type: "string" } } },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId: row.agent.id, clientId: row.conv.clientId, conversationId, ms: Date.now() - started }).catch(() => {});
  if (!data.send || !data.text.trim()) return { skip: "ai_skipped" };
  return { text: data.text.trim().slice(0, 2000) + hint };
}

/** Предпросмотр: какой текст получит этот клиент на шаге (ничего не отправляется). */
export async function previewStep(c: Campaign, step: number, conversationId: string) {
  const st = c.steps[step];
  if (!st) return { skip: "no_step" } as const;
  return compose(c, st, conversationId);
}

/** Отправить одно сообщение рассылки/цепочки. */
export async function sendRun(run: CampaignRun): Promise<void> {
  const fail = (status: CampaignRun["status"], error: string) =>
    db.update(campaignRuns).set({ status, error: error.slice(0, 200), sentAt: status === "stopped" ? null : new Date() }).where(eq(campaignRuns.id, run.id));
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, run.campaignId));
  if (!c || !c.enabled) return void (await fail("stopped", "campaign_off"));
  const [row] = await db
    .select({ conv: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, run.conversationId));
  if (!row) return void (await fail("failed", "not_found"));
  if (row.conv.context?.optOut) return void (await fail("stopped", "opt_out"));
  // Цепочка: клиент ответил после начала — дальше не пишем
  if (c.kind === "sequence") {
    const [reply] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, run.conversationId), eq(messages.role, "user"), gt(messages.createdAt, run.sentAt ?? run.enrolledAt)))
      .limit(1);
    if (reply) return void (await fail("stopped", "replied"));
  }
  if (c.options.quietHours) {
    const later = quietUntil();
    if (later) return void (await db.update(campaignRuns).set({ dueAt: later }).where(eq(campaignRuns.id, run.id)));
  }
  if (row.channel.type === "whatsapp" || row.channel.type === "instagram") {
    const [last] = await db
      .select({ at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, run.conversationId), eq(messages.role, "user")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (!last || Date.now() - last.at.getTime() > WINDOW_MS) return void (await fail("skipped", "outside_24h_window"));
  }
  const step = c.steps[run.step];
  if (!step) return void (await db.update(campaignRuns).set({ status: "done" }).where(eq(campaignRuns.id, run.id)));
  let composed: Awaited<ReturnType<typeof compose>>;
  try {
    composed = await compose(c, step, run.conversationId);
  } catch (e) {
    return void (await fail("failed", e instanceof Error ? e.message : String(e)));
  }
  if ("skip" in composed) return void (await fail("skipped", composed.skip));

  const { addMessage, deliver } = await import("@/lib/conversations");
  const meta = { campaign: { id: c.id, name: c.name, step: run.step } };
  let messageId: string;
  try {
    if (row.channel.type === "api") {
      // Свой бот клиента забирает сообщение из очереди напоминаний и отправляет сам
      const m = await addMessage(run.conversationId, "assistant", composed.text, { meta: { ...meta, followUp: true } });
      messageId = m.id;
    } else {
      const externalId = await deliver(row.channel, row.conv, composed.text);
      const m = await addMessage(run.conversationId, "assistant", composed.text, { meta, externalId: externalId ?? undefined });
      messageId = m.id;
    }
  } catch (e) {
    return void (await fail("failed", e instanceof Error ? e.message : String(e)));
  }
  const next = c.kind === "sequence" ? c.steps[run.step + 1] : undefined;
  await db
    .update(campaignRuns)
    .set(
      next
        ? { status: "pending", step: run.step + 1, dueAt: new Date(Date.now() + next.delayHours * 3600_000), sentAt: new Date(), messageId, error: null }
        : { status: "sent", sentAt: new Date(), messageId, error: null },
    )
    .where(eq(campaignRuns.id, run.id));
}

/** Клиент написал «стоп»: отписать и остановить всё, что ему запланировано. */
export async function optOut(conversationId: string) {
  const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversationId));
  await db.update(conversations).set({ context: { ...cur?.context, optOut: true } }).where(eq(conversations.id, conversationId));
  await db
    .update(campaignRuns)
    .set({ status: "stopped", error: "opt_out" })
    .where(and(eq(campaignRuns.conversationId, conversationId), eq(campaignRuns.status, "pending")));
}

/** Один проход: набор в цепочки, отправка подошедших, завершение рассылок. */
export async function campaignsTick(opts: { enroll?: boolean } = {}) {
  if (opts.enroll !== false) await enrollSequences().catch((e) => console.error("enroll sequences failed", e));
  const due = await db
    .select()
    .from(campaignRuns)
    .where(and(eq(campaignRuns.status, "pending"), lte(campaignRuns.dueAt, new Date())))
    .orderBy(asc(campaignRuns.dueAt))
    .limit(PER_TICK);
  for (const r of due) await sendRun(r).catch((e) => console.error("campaign send failed", r.id, e));
  // Рассылки: всё отправлено — готово; время пришло — «отправляется»
  for (const c of await db.select().from(campaigns).where(and(eq(campaigns.kind, "broadcast"), inArray(campaigns.status, ["scheduled", "sending"])))) {
    const [left] = await db
      .select({ n: sql<number>`count(*)` })
      .from(campaignRuns)
      .where(and(eq(campaignRuns.campaignId, c.id), eq(campaignRuns.status, "pending")));
    if (!Number(left.n)) await db.update(campaigns).set({ status: "done", updatedAt: new Date() }).where(eq(campaigns.id, c.id));
    else if (c.status === "scheduled" && c.scheduleAt && c.scheduleAt.getTime() <= Date.now()) await db.update(campaigns).set({ status: "sending" }).where(eq(campaigns.id, c.id));
  }
  return due.length;
}

/** Цифры кампании: кому поставлено, отправлено, пропущено, ошибки, ответили. */
export async function campaignStats(campaignId: string) {
  const rows = await db
    .select({ status: campaignRuns.status, error: campaignRuns.error, n: sql<number>`count(*)` })
    .from(campaignRuns)
    .where(eq(campaignRuns.campaignId, campaignId))
    .groupBy(campaignRuns.status, campaignRuns.error);
  const s = { total: 0, pending: 0, sent: 0, skipped: 0, failed: 0, replied: 0, optOut: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    s.total += n;
    if (r.status === "pending") s.pending += n;
    else if (r.status === "sent" || r.status === "done") s.sent += n;
    else if (r.status === "skipped") s.skipped += n;
    else if (r.status === "failed") s.failed += n;
    else if (r.status === "stopped" && r.error === "replied") s.replied += n;
    else if (r.status === "stopped" && r.error === "opt_out") s.optOut += n;
  }
  return s;
}

export function startCampaigns() {
  const g = globalThis as unknown as { __campaignsTimer?: ReturnType<typeof setInterval>; __campaignsRunning?: boolean };
  if (g.__campaignsTimer) return;
  let n = 0;
  g.__campaignsTimer = setInterval(() => {
    if (g.__campaignsRunning) return;
    g.__campaignsRunning = true;
    // набор в цепочки — раз в 5 минут, отправка — каждую минуту
    void campaignsTick({ enroll: n++ % 5 === 0 })
      .catch((e) => console.error("campaigns tick failed", e))
      .finally(() => (g.__campaignsRunning = false));
  }, 60_000);
  g.__campaignsTimer.unref?.();
}
