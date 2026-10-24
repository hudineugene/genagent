import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, clients, incidents, monitors, type Monitor } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";

/**
 * Упреждающее выявление проблем: проверяем сайт / API клиента (код ответа, нужный текст, время ответа) или
 * принимаем сигналы из его систем (ошибки, метрики). N сбоев подряд — инцидент: команде в Telegram и черновик
 * сообщения клиентам, которых это заденет, — чтобы узнали раньше, чем начнут писать в поддержку. Из черновика —
 * рассылка (создаётся выключенной, человек проверяет и запускает). Восстановилось — «всё работает» и черновик.
 */
const MODEL = "claude-haiku-5-5";
export const newMonitorKey = () => `mn_${randomBytes(18).toString("base64url")}`;

export type CheckResult = { ok: boolean; ms: number; error: string };

/** Одна проверка адреса. */
export async function checkUrl(m: Pick<Monitor, "url" | "expectText" | "maxMs">): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await fetch(m.url, { redirect: "follow", signal: AbortSignal.timeout(Math.max(m.maxMs, 3000) + 5000), headers: { "user-agent": "GenAgent-Monitor/1.0" } });
    const body = m.expectText ? await res.text() : "";
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
    if (m.expectText && !body.toLowerCase().includes(m.expectText.toLowerCase())) return { ok: false, ms, error: `нет текста «${m.expectText}»` };
    if (ms > m.maxMs) return { ok: false, ms, error: `медленно: ${ms} мс (норма до ${m.maxMs})` };
    return { ok: true, ms, error: "" };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "нет ответа (таймаут)" : e.message) : String(e);
    return { ok: false, ms: Date.now() - started, error: msg.slice(0, 200) };
  }
}

type Drafts = { draft: string; resolved: string };

async function writeDrafts(m: Monitor, error: string): Promise<Drafts> {
  const [client] = await db.select({ name: clients.name, brandVoice: clients.brandVoice, description: clients.description }).from(clients).where(eq(clients.id, m.clientId));
  const fallback = {
    draft: `Здравствуйте! Сейчас наблюдаются перебои в работе сервиса «${m.name}». Мы уже знаем о проблеме и исправляем её. Сообщим, как только всё заработает. Приносим извинения за неудобства.`,
    resolved: `Сервис «${m.name}» снова работает в обычном режиме. Спасибо за терпение!`,
  };
  const key = apiKey("anthropic");
  if (!key) return fallback;
  try {
    const started = Date.now();
    const { data, usage, model } = await generateJson<Drafts>(key, MODEL, {
      system: [
        `Ты пишешь упреждающее сообщение клиентам компании «${client?.name ?? ""}»${client?.description ? ` (${client.description})` : ""}: у неё сбой, клиенты должны узнать раньше, чем начнут писать в поддержку.`,
        client?.brandVoice ? `Голос бренда: ${client.brandVoice}` : "",
        "draft — 2–4 предложения: что не работает простыми словами (без технических деталей и кодов ошибок), что команда уже чинит, что делать клиенту сейчас (если есть обходной путь — подождать, позвонить, оплатить позже), извинение. Не обещай сроков, которых нет.",
        "resolved — 1–2 предложения: всё снова работает, спасибо за терпение.",
        "Язык — русский.",
      ]
        .filter(Boolean)
        .join("\n"),
      prompt: `Сервис: ${m.name}${m.url ? ` (${m.url})` : ""}. Кого задевает: ${m.audience || "всех клиентов, кто им пользуется"}. Что видно: ${error}.`,
      schema: { type: "object", additionalProperties: false, required: ["draft", "resolved"], properties: { draft: { type: "string" }, resolved: { type: "string" } } },
      effort: "low",
    });
    await logUsage({ source: "generate", model, usage, clientId: m.clientId, ms: Date.now() - started }).catch(() => {});
    return { draft: data.draft.trim().slice(0, 2000) || fallback.draft, resolved: data.resolved.trim().slice(0, 1000) || fallback.resolved };
  } catch (e) {
    console.error("incident draft failed", e);
    return fallback;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function notify(clientId: string, html: string) {
  const n = await import("@/lib/notify/telegram");
  await n.sendToTeam(html).catch(() => {});
  await n.sendToOwners(clientId, html).catch(() => {});
}

/** Записать результат проверки (или сигнал): сбой N раз подряд — инцидент, восстановление — закрыть. */
async function record__(m: Monitor, r: CheckResult, now = new Date()) {
  const fails = r.ok ? 0 : m.fails + 1;
  const goesDown = !r.ok && fails >= m.failThreshold && m.status !== "down";
  const goesUp = r.ok && m.status === "down";
  const status = goesDown ? "down" : goesUp ? "up" : r.ok ? "up" : m.status === "unknown" && fails < m.failThreshold ? "unknown" : m.status;
  await db.update(monitors).set({ fails, status, lastCheckAt: now, lastMs: r.ms, lastError: r.ok ? null : r.error, updatedAt: now }).where(eq(monitors.id, m.id));
  if (goesDown) {
    const d = await writeDrafts(m, r.error);
    const [inc] = await db.insert(incidents).values({ monitorId: m.id, clientId: m.clientId, error: r.error, draft: d.draft, resolvedDraft: d.resolved, startedAt: now }).returning();
    await notify(m.clientId, `🚨 <b>Сбой: ${esc(m.name)}</b>\n${esc(r.error)}${m.url ? `\n${esc(m.url)}` : ""}\n\nЧерновик сообщения клиентам готов — проверьте и разошлите в студии: «Контроль сервисов».\n\n<i>${esc(d.draft)}</i>`);
    return { incident: inc };
  }
  if (goesUp) {
    const [open] = await db.select().from(incidents).where(and(eq(incidents.monitorId, m.id), eq(incidents.status, "open"))).orderBy(desc(incidents.startedAt)).limit(1);
    if (open) await db.update(incidents).set({ status: "resolved", resolvedAt: now }).where(eq(incidents.id, open.id));
    const mins = open ? Math.round((now.getTime() - open.startedAt.getTime()) / 60_000) : 0;
    await notify(m.clientId, `✅ <b>Снова работает: ${esc(m.name)}</b>${open ? `\nСбой длился ${mins} мин.${open.campaignId ? " Клиентам сообщали о сбое — разошлите и «всё работает» (черновик в студии)." : ""}` : ""}`);
  }
  return {};
}

export async function record(m: Monitor, r: CheckResult, now = new Date()) {
  return withKeys({ clientId: m.clientId }, () => record__(m, r, now));
}

/** Проверить сейчас. */
export async function runMonitor(m: Monitor, now = new Date()) {
  if (m.kind !== "http" || !m.url) return null;
  const r = await checkUrl(m);
  await record(m, r, now);
  return r;
}

/** Каждую минуту: проверки, которым пора по интервалу. */
export async function monitorsTick(now = new Date()) {
  const list = await db.select().from(monitors).where(and(eq(monitors.enabled, true), eq(monitors.kind, "http")));
  for (const m of list) {
    if (m.lastCheckAt && now.getTime() - m.lastCheckAt.getTime() < m.intervalMin * 60_000 - 5000) continue;
    await runMonitor(m, now).catch((e) => console.error("monitor failed", m.id, e));
  }
}

/** Сигнал из системы клиента: { status: "down" | "up", message } или { errors: число, threshold?: число }. */
export async function signal(m: Monitor, body: { status?: string; message?: string; errors?: number; threshold?: number }) {
  const bad = body.status ? body.status === "down" || body.status === "error" : typeof body.errors === "number" ? body.errors > (body.threshold ?? 0) : false;
  const error = (body.message || (typeof body.errors === "number" ? `ошибок: ${body.errors}${body.threshold != null ? ` (порог ${body.threshold})` : ""}` : "сигнал о сбое")).slice(0, 300);
  // Сигнал из системы — уже вывод, не ждём повторов
  return record({ ...m, fails: bad ? Math.max(m.fails, m.failThreshold - 1) : m.fails }, { ok: !bad, ms: 0, error: bad ? error : "" });
}

/** Черновик → рассылка (выключенная) по клиентам, писавшим за последние N дней: человек проверяет и запускает. */
export async function draftToCampaign(incidentId: string, text: string, days: number, which: "draft" | "resolved") {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc) return null;
  const [m] = await db.select().from(monitors).where(eq(monitors.id, inc.monitorId));
  const [c] = await db
    .insert(campaigns)
    .values({
      clientId: inc.clientId,
      kind: "broadcast",
      name: `${which === "draft" ? "Сбой" : "Снова работает"}: ${m?.name ?? ""}`.slice(0, 100),
      segment: { activeWithinDays: days },
      steps: [{ delayHours: 0, mode: "text", text }],
      status: "draft",
      enabled: false,
      options: { quietHours: false, optOutHint: false },
    })
    .returning();
  if (which === "draft") await db.update(incidents).set({ campaignId: c.id, draft: text }).where(eq(incidents.id, incidentId));
  else await db.update(incidents).set({ resolvedDraft: text }).where(eq(incidents.id, incidentId));
  return c;
}
