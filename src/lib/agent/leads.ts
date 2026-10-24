import "server-only";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, clients, conversations, messages } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { jsonText } from "@/db/dialect";
import { studioTz } from "@/lib/general";

/**
 * Утренняя сводка лидов (Telegram, бот уведомлений). Лид — разговор за сутки, где клиент дошёл до дела: агент передал
 * его менеджеру или бот прислал результат (заявка, бриф, просмотр, заказ, оплата). По каждому: кто, что хочет
 * (выжимка при передаче, результат или память о клиенте), статус (ждёт ответа N ч / менеджер ответил) — сначала
 * недовольные, потом кто дольше ждёт. Без ИИ: только данные из базы. Тестовые разговоры не берём.
 */
export type LeadsSettings = { enabled: boolean; hour: number; lastDay?: string };
const KEY = "leadsDigest";
export const LEADS_DEFAULTS: LeadsSettings = { enabled: true, hour: 9 };
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LEADS = 15;
/** Не результат: оценки, служебные события */
const NOT_LEAD = new Set(["rating_up", "rating_down", "followup_sent", "brief_started"]);
const CHANNEL: Record<string, string> = { telegram: "Telegram", widget: "сайт", instagram: "Instagram", threads: "Threads", email: "почта", api: "бот", whatsapp: "WhatsApp" };

export async function getLeadsSettings(): Promise<LeadsSettings> {
  return { ...LEADS_DEFAULTS, ...((await getSetting<LeadsSettings>(KEY)) ?? {}) };
}

export async function saveLeadsSettings(patch: Partial<LeadsSettings>) {
  await setSetting(KEY, { ...(await getLeadsSettings()), ...patch });
}

export type Lead = {
  conversationId: string;
  client: string;
  who: string;
  channel: string;
  wants: string;
  status: "upset" | "waiting" | "hot" | "answered" | "result";
  /** Карточка лида: «горячесть» и поля со слов клиента */
  temperature?: "hot" | "warm" | "cold";
  waitingMs: number;
  results: string[];
};

const HEAT = { hot: "🔥", warm: "🌤", cold: "❄️" } as const;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Лиды за период (по умолчанию — последние сутки). */
export async function collectLeads(sinceMs = Date.now() - DAY_MS): Promise<Lead[]> {
  const since = new Date(sinceMs);
  const handoffs = await db
    .select({ conversationId: messages.conversationId, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.role, "system"), eq(messages.text, "handoff"), gt(messages.createdAt, since), eq(conversations.isTest, false)))
    .orderBy(desc(messages.createdAt));
  const events = await db
    .select({ conversationId: agentEvents.conversationId, type: agentEvents.type, label: agentEvents.label })
    .from(agentEvents)
    .innerJoin(conversations, eq(conversations.id, agentEvents.conversationId))
    .where(and(gt(agentEvents.createdAt, since), eq(conversations.isTest, false)));
  const resultEvents = events.filter((e) => e.conversationId && !NOT_LEAD.has(e.type));
  // Горячие по карточке лида — даже если до передачи менеджеру ещё не дошло
  const hot = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.isTest, false),
        eq(conversations.kind, "dm"),
        gt(conversations.lastMessageAt, since),
        sql`${jsonText(conversations.context, "lead.temperature")} = 'hot'`,
        sql`coalesce(${jsonText(conversations.context, "lead.looksTest")}, 0) = 0`,
      ),
    );
  const ids = [...new Set([...handoffs.map((h) => h.conversationId), ...resultEvents.map((e) => e.conversationId as string), ...hot.map((h) => h.id)])];
  if (!ids.length) return [];

  const convs = await db
    .select({ conversation: conversations, client: clients.name })
    .from(conversations)
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .where(and(inArray(conversations.id, ids), eq(conversations.kind, "dm")));
  const ops = await db
    .select({ conversationId: messages.conversationId, createdAt: messages.createdAt })
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), eq(messages.role, "operator"), gt(messages.createdAt, since)));
  const lastUser = await db
    .select({ conversationId: messages.conversationId, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt));

  const now = Date.now();
  const leads: Lead[] = [];
  for (const { conversation: c, client } of convs) {
    const h = handoffs.find((x) => x.conversationId === c.id);
    const results = [...new Set(resultEvents.filter((e) => e.conversationId === c.id).map((e) => e.label || e.type))];
    const summary = h?.meta?.summary ?? "";
    const wantsLine = summary.split("\n").find((l) => l.startsWith("Ищет:"))?.replace(/^Ищет:\s*/, "");
    const memory = c.context?.memory?.facts?.find((f) => !/^зовут|^имя/i.test(f));
    const said = lastUser.find((m) => m.conversationId === c.id)?.text;
    const card = c.context?.lead;
    const cardLine = card?.fields.length ? card.fields.map((f) => `${f.label}: ${f.value}`).join("; ") : "";
    const wants = (cardLine || wantsLine || (results.length ? results.join(", ") : "") || memory || said || "—").replace(/\s+/g, " ").slice(0, 200);
    const answered = h ? ops.some((o) => o.conversationId === c.id && o.createdAt > h.createdAt) : ops.some((o) => o.conversationId === c.id);
    const status: Lead["status"] =
      h?.meta?.upset && !answered ? "upset" : h && !answered && c.needsAttention ? "waiting" : h ? "answered" : results.length ? "result" : "hot";
    leads.push({
      conversationId: c.id,
      client,
      who: c.contactName || c.contactHandle || "клиент",
      channel: CHANNEL[c.channelType] ?? c.channelType,
      wants,
      status,
      waitingMs: status === "waiting" || status === "upset" ? now - (h?.createdAt.getTime() ?? now) : 0,
      results,
      temperature: card?.temperature,
    });
  }
  const rank = { upset: 0, waiting: 1, hot: 2, result: 3, answered: 4 } as const;
  const heat = (l: Lead) => (l.temperature === "hot" ? 0 : l.temperature === "warm" ? 1 : 2);
  return leads.sort((a, b) => rank[a.status] - rank[b.status] || heat(a) - heat(b) || b.waitingMs - a.waitingMs);
}

const hours = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60000))} мин` : `${Math.round(ms / 3600_000)} ч`);

export function leadsHtml(leads: Lead[], adminUrl?: string) {
  const waiting = leads.filter((l) => l.status === "waiting" || l.status === "upset").length;
  const lines = [`🎯 <b>Лиды за сутки: ${leads.length}</b>${waiting ? ` · ждут ответа: ${waiting}` : ""}`];
  for (const l of leads.slice(0, MAX_LEADS)) {
    const mark =
      l.status === "upset"
        ? `🔴 недоволен, ждёт ${hours(l.waitingMs)}`
        : l.status === "waiting"
          ? `⏳ ждёт ${hours(l.waitingMs)}`
          : l.status === "answered"
            ? "✅ ответили"
            : l.status === "hot"
              ? "🔥 горячий — менеджеру ещё не передан"
              : "📌 " + esc(l.results.join(", "));
    const link = adminUrl ? ` <a href="${adminUrl}/inbox?c=${l.conversationId}">→</a>` : "";
    const heat = l.temperature ? `${HEAT[l.temperature]} ` : "";
    lines.push("", `${heat}<b>${esc(l.who)}</b> · ${esc(l.client)} · ${l.channel}${link}`, `${esc(l.wants)}`, mark);
  }
  if (leads.length > MAX_LEADS) lines.push("", `…и ещё ${leads.length - MAX_LEADS}`);
  return lines.join("\n");
}

/** Отправить сводку сейчас. false — лидов нет (ничего не отправлено). */
export async function sendLeadsDigest(sinceMs?: number): Promise<boolean> {
  const leads = await collectLeads(sinceMs);
  if (!leads.length) return false;
  const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
  const s = await getNotifySettings();
  await notifyTestsReport(leadsHtml(leads, s?.adminUrl), s?.adminUrl ? `${s.adminUrl}/inbox?f=attention` : undefined);
  return true;
}

function kyivNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: studioTz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function startLeadsDigest() {
  const g = globalThis as unknown as { __leadsTimer?: ReturnType<typeof setInterval> };
  if (g.__leadsTimer) return;
  const tick = async () => {
    const s = await getLeadsSettings();
    if (!s.enabled) return;
    const now = kyivNow();
    if (now.hour !== s.hour || s.lastDay === now.day) return;
    await saveLeadsSettings({ lastDay: now.day });
    await sendLeadsDigest().catch((e) => console.error("leads digest failed", e));
  };
  setTimeout(() => void tick(), 5 * 60_000).unref?.();
  g.__leadsTimer = setInterval(() => void tick(), 20 * 60_000);
  g.__leadsTimer.unref?.();
}
