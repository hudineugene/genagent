import "server-only";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  channels,
  clientIntegrations,
  clients,
  conversations,
  type ClientIntegration,
  type IntegrationEventType,
  type LeadCard,
} from "@/db/schema";
import { appendRow, ensureHeader, spreadsheetId, updateRow } from "@/lib/google/sheets";
import { assertPublicHost } from "@/lib/agent/custom-tools";

/**
 * События клиента во внешние системы: заявка (карточка клиента обновилась), передача менеджеру, запись в календарь,
 * оценка ответа, событие бота (заявка, просмотр, сделка, заказ…). Google Таблица — строка на событие
 * (заявка одного разговора обновляет свою строку), вебхук — JSON с подписью HMAC. Тестовые разговоры не отправляются.
 * Отправка — в фоне, ответ клиенту не задерживает; сбой вебхука — до 3 попыток.
 */

export type EventPayload = {
  event: IntegrationEventType;
  at: string;
  client: { id: string; name: string };
  agent: { id: string; name: string } | null;
  channel: { type: string; name: string } | null;
  conversation: { id: string; contact: string; handle: string; link: string | null } | null;
  lead?: { temperature: LeadCard["temperature"]; reason: string; fields: Record<string, string> };
  summary?: string;
  reason?: string;
  booking?: { start: string; service: string; name: string; phone: string; comment: string };
  rating?: "up" | "down";
  botEvent?: { type: string; label: string; value: number | null };
  form?: { id: string; name: string; answers: Record<string, string>; score: number | null; maxScore: number | null };
  document?: { type: string; filename: string; fields: Record<string, string>; summary: string };
  meeting?: { title: string; kind: string; summary: string; tasks: { who: string; what: string; due: string }[]; score: number | null };
  points?: { program: string; contact: string; delta: number; balance: number; reason: string };
};

export type EventInput = {
  clientId: string;
  agentId?: string | null;
  conversationId?: string | null;
  summary?: string;
  reason?: string;
  lead?: LeadCard | null;
  booking?: EventPayload["booking"];
  rating?: "up" | "down";
  botEvent?: EventPayload["botEvent"];
  form?: EventPayload["form"];
  document?: EventPayload["document"];
  meeting?: EventPayload["meeting"];
  points?: EventPayload["points"];
};

const LABELS: Record<IntegrationEventType, string> = {
  lead: "Заявка",
  handoff: "Передача менеджеру",
  booking: "Запись",
  rating: "Оценка",
  bot_event: "Событие бота",
  form: "Анкета",
  document: "Документ",
  meeting: "Встреча",
  points: "Баллы",
};

export const SHEET_HEADER = ["Дата", "Событие", "Агент", "Канал", "Клиент", "Контакт", "Температура", "Данные клиента", "Подробности", "Диалог"];
const TEMPERATURE: Record<string, string> = { hot: "🔥 горячий", warm: "тёплый", cold: "холодный" };

async function buildPayload(event: IntegrationEventType, input: EventInput): Promise<EventPayload | null> {
  const [client] = await db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.id, input.clientId));
  if (!client) return null;
  let conv: { id: string; contactName: string; contactHandle: string; isTest: boolean; context: { lead?: LeadCard } | null; agentId: string; channelId: string } | undefined;
  if (input.conversationId) {
    [conv] = await db
      .select({ id: conversations.id, contactName: conversations.contactName, contactHandle: conversations.contactHandle, isTest: conversations.isTest, context: conversations.context, agentId: conversations.agentId, channelId: conversations.channelId })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId));
    if (conv?.isTest) return null;
  }
  const lead = input.lead ?? conv?.context?.lead;
  if (lead?.looksTest) return null;
  const agentId = input.agentId ?? conv?.agentId;
  const [agent] = agentId ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId)) : [];
  const [channel] = conv ? await db.select({ type: channels.type, name: channels.name }).from(channels).where(eq(channels.id, conv.channelId)) : [];
  const { getNotifySettings } = await import("@/lib/notify/telegram");
  const admin = (await getNotifySettings().catch(() => undefined))?.adminUrl;
  return {
    event,
    at: new Date().toISOString(),
    client,
    agent: agent ?? null,
    channel: channel ?? null,
    conversation: conv ? { id: conv.id, contact: conv.contactName, handle: conv.contactHandle, link: admin ? `${admin}/inbox?c=${conv.id}` : null } : null,
    ...(lead ? { lead: { temperature: lead.temperature, reason: lead.reason, fields: Object.fromEntries(lead.fields.map((f) => [f.label, f.value])) } } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.booking ? { booking: input.booking } : {}),
    ...(input.rating ? { rating: input.rating } : {}),
    ...(input.botEvent ? { botEvent: input.botEvent } : {}),
    ...(input.form ? { form: input.form } : {}),
    ...(input.document ? { document: input.document } : {}),
    ...(input.meeting ? { meeting: input.meeting } : {}),
    ...(input.points ? { points: input.points } : {}),
  };
}

/** Строка для Google Таблицы. */
export function sheetRow(p: EventPayload): string[] {
  const when = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", dateStyle: "short", timeStyle: "short" }).format(new Date(p.at));
  const details =
    p.event === "booking" && p.booking
      ? `${p.booking.service} · ${p.booking.start} · ${p.booking.name} ${p.booking.phone}${p.booking.comment ? ` · ${p.booking.comment}` : ""}`
      : p.event === "rating"
        ? p.rating === "up"
          ? "👍"
          : "👎"
        : p.event === "bot_event" && p.botEvent
          ? `${p.botEvent.label || p.botEvent.type}${p.botEvent.value != null ? ` · ${p.botEvent.value}` : ""}`
          : p.event === "document" && p.document
            ? `${p.document.filename}: ${Object.entries(p.document.fields).map(([k, v]) => `${k}: ${v}`).join("; ")}${p.document.summary ? ` · ${p.document.summary}` : ""}`
          : p.event === "meeting" && p.meeting
            ? `${p.meeting.summary}${p.meeting.tasks.length ? ` · Задачи: ${p.meeting.tasks.map((t) => `${t.who ? `${t.who}: ` : ""}${t.what}${t.due ? ` (до ${t.due})` : ""}`).join("; ")}` : ""}${p.meeting.score != null ? ` · оценка ${p.meeting.score}/10` : ""}`
          : p.event === "points" && p.points
            ? `${p.points.delta > 0 ? "+" : ""}${p.points.delta} · баланс ${p.points.balance}${p.points.reason ? ` · ${p.points.reason}` : ""}`
          : p.event === "form" && p.form
            ? `${p.form.name}: ${Object.entries(p.form.answers).map(([k, v]) => `${k}: ${v}`).join("; ")}${p.form.score != null ? ` · баллы ${p.form.score}/${p.form.maxScore}` : ""}`
            : (p.summary ?? p.lead?.reason ?? p.reason ?? "");
  return [
    when,
    p.event === "bot_event" && p.botEvent ? p.botEvent.label || LABELS.bot_event : p.event === "form" && p.form ? `${LABELS.form}: ${p.form.name}` : p.event === "document" && p.document ? `${LABELS.document}: ${p.document.type}` : p.event === "meeting" && p.meeting ? `${LABELS.meeting}: ${p.meeting.title}` : p.event === "points" && p.points ? `${LABELS.points}: ${p.points.program}` : LABELS[p.event],
    p.agent?.name ?? "",
    p.channel ? `${p.channel.type} ${p.channel.name}` : "",
    p.conversation?.contact ?? "",
    p.conversation?.handle ?? "",
    p.lead ? (TEMPERATURE[p.lead.temperature] ?? p.lead.temperature) : "",
    p.lead ? Object.entries(p.lead.fields).map(([k, v]) => `${k}: ${v}`).join("; ") : "",
    details.slice(0, 2000),
    p.conversation?.link ?? "",
  ];
}

const status = (id: string, s: string) =>
  db.update(clientIntegrations).set({ lastStatus: s.slice(0, 120), lastAt: new Date() }).where(eq(clientIntegrations.id, id)).catch(() => {});

async function toSheet(integ: ClientIntegration, p: EventPayload) {
  const cfg = integ.config as { url: string; sheet: string };
  const id = spreadsheetId(cfg.url);
  if (!id) throw new Error("sheet_bad_url");
  const sheet = cfg.sheet || "Лист1";
  await ensureHeader(id, sheet, SHEET_HEADER);
  const row = sheetRow(p);
  // Заявка одного разговора — одна строка: при обновлении карточки переписываем её
  if (p.event === "lead" && p.conversation) {
    const [c] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, p.conversation.id));
    const known = c?.context?.sheetRows?.[integ.id];
    if (known) return updateRow(id, sheet, known, row);
    const n = await appendRow(id, sheet, row);
    if (n) {
      const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, p.conversation.id));
      await db
        .update(conversations)
        .set({ context: { ...cur?.context, sheetRows: { ...cur?.context?.sheetRows, [integ.id]: n } } })
        .where(eq(conversations.id, p.conversation.id));
    }
    return;
  }
  await appendRow(id, sheet, row);
}

export function signature(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function toWebhook(integ: ClientIntegration, p: EventPayload) {
  const cfg = integ.config as { url: string; secret: string };
  const url = new URL(cfg.url);
  await assertPublicHost(url.hostname);
  const body = JSON.stringify(p);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-genagent-event": p.event, "x-genagent-signature": signature(cfg.secret, body) },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
}

const RETRY_MS = [2_000, 10_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Отправить одно событие в одну интеграцию (с повторами для вебхука). */
export async function deliver(integ: ClientIntegration, p: EventPayload, opts: { retries?: boolean } = {}) {
  const attempts = integ.kind === "webhook" && opts.retries !== false ? RETRY_MS.length + 1 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      if (integ.kind === "sheet") await toSheet(integ, p);
      else await toWebhook(integ, p);
      await status(integ.id, "ok");
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i === attempts - 1) {
        console.error("integration delivery failed", integ.id, msg);
        await status(integ.id, `error: ${msg}`);
        return false;
      }
      await sleep(RETRY_MS[i]);
    }
  }
  return false;
}

/** Событие клиента — во все его включённые интеграции, подписанные на этот тип. Возвращает число успешных отправок. */
export async function emitEvent(event: IntegrationEventType, input: EventInput): Promise<number> {
  try {
    const list = (await db
      .select()
      .from(clientIntegrations)
      .where(and(eq(clientIntegrations.clientId, input.clientId), eq(clientIntegrations.enabled, true)))).filter((i) => i.events.includes(event));
    if (!list.length) return 0;
    const payload = await buildPayload(event, input);
    if (!payload) return 0;
    const results = await Promise.all(list.map((i) => deliver(i, payload)));
    return results.filter(Boolean).length;
  } catch (e) {
    console.error("emit event failed", event, e);
    return 0;
  }
}

/** Пробная отправка из админки: пример заявки (без повторов). */
export async function sendTest(integ: ClientIntegration) {
  const [client] = await db.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.id, integ.clientId));
  const p: EventPayload = {
    event: "lead",
    at: new Date().toISOString(),
    client: client ?? { id: integ.clientId, name: "" },
    agent: null,
    channel: { type: "test", name: "Проверка" },
    conversation: null,
    lead: { temperature: "warm", reason: "Пробная строка из GenAgent", fields: { Имя: "Тест", Телефон: "+380000000000" } },
    summary: "Проверка подключения — эту строку можно удалить.",
  };
  if (integ.kind === "sheet") {
    const cfg = integ.config as { url: string; sheet: string };
    const id = spreadsheetId(cfg.url);
    if (!id) throw new Error("sheet_bad_url");
    await ensureHeader(id, cfg.sheet || "Лист1", SHEET_HEADER);
    await appendRow(id, cfg.sheet || "Лист1", sheetRow(p));
    await status(integ.id, "ok");
    return;
  }
  const ok = await deliver(integ, p, { retries: false });
  if (!ok) throw new Error((await db.select({ s: clientIntegrations.lastStatus }).from(clientIntegrations).where(eq(clientIntegrations.id, integ.id)))[0]?.s ?? "error");
}
