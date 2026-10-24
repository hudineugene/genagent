import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { dataTables, reminderLog, reminders, type DataTable, type Reminder } from "@/db/schema";
import { refreshTable, toIsoDate } from "@/lib/data/tables";
import { addDays, daysBetween, kyivNow, parseContact, reach } from "@/lib/reach";

/**
 * Напоминания и оповещения по таблице: по дате (оплатить счёт, продлить подписку, доставка завтра) — за N дней,
 * раз в день в заданный час; по статусу (заказ «отправлен», «доставлен», смена графика) — как только статус в
 * таблице изменился (кроме ночи). Первый проход по статусам только запоминает текущие значения.
 */
const CATCH_UP_DAYS = 3;
const PER_RUN = 200;

const norm = (s: string) => s.trim().toLowerCase();

/** «{{Столбец}}» → значение строки (без учёта регистра); неизвестные поля — пусто. */
export function renderTemplate(tpl: string, columns: string[], row: string[]) {
  const idx = new Map(columns.map((c, i) => [norm(c), i]));
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => {
    const i = idx.get(norm(name));
    return i == null ? "" : (row[i] ?? "").trim();
  });
}

type Hit = { key: string; value: string; contact: string; text: string };

/** Какие строки пора напомнить сегодня (по дате). */
export function dateHits(r: Pick<Reminder, "dateColumn" | "offsetDays" | "keyColumn" | "statusColumn" | "statusValues" | "contactColumn" | "message">, t: Pick<DataTable, "columns" | "rows">, today: string): Hit[] {
  const cols = t.columns.map((c) => c.name);
  const di = cols.indexOf(r.dateColumn);
  const ci = cols.indexOf(r.contactColumn);
  if (di < 0 || ci < 0) return [];
  const ki = cols.indexOf(r.keyColumn);
  const si = cols.indexOf(r.statusColumn);
  const allowed = r.statusValues.map(norm).filter(Boolean);
  const out: Hit[] = [];
  for (const row of t.rows) {
    const date = toIsoDate(row[di] ?? "");
    const contact = (row[ci] ?? "").trim();
    if (!date || !contact) continue;
    if (allowed.length && si >= 0 && !allowed.includes(norm(row[si] ?? ""))) continue;
    const target = addDays(date, -r.offsetDays);
    const late = daysBetween(target, today);
    if (late < 0 || late > CATCH_UP_DAYS) continue;
    // Напоминание «до даты» после самой даты уже не нужно
    if (r.offsetDays >= 0 && today > date) continue;
    out.push({ key: (ki >= 0 && row[ki]?.trim()) || contact, value: date, contact, text: renderTemplate(r.message, cols, row) });
  }
  return out;
}

async function lastValues(reminderId: string) {
  const rows = await db.select().from(reminderLog).where(eq(reminderLog.reminderId, reminderId)).orderBy(desc(reminderLog.createdAt));
  const last = new Map<string, string>();
  const seen = new Set<string>();
  for (const l of rows) {
    if (!last.has(l.rowKey)) last.set(l.rowKey, l.value);
    seen.add(`${l.rowKey}\u0000${l.value}`);
  }
  return { last, seen, empty: rows.length === 0 };
}

export type RunResult = { sent: number; noChat: string[]; failed: number; baseline?: number };

/** Выполнить напоминание сейчас. */
export async function runReminder(r: Reminder, now = new Date()): Promise<RunResult> {
  const res: RunResult = { sent: 0, noChat: [], failed: 0 };
  if (!r.tableId) return res;
  const [raw] = await db.select().from(dataTables).where(eq(dataTables.id, r.tableId));
  if (!raw) return res;
  const t = await refreshTable(raw);
  const cols = t.columns.map((c) => c.name);
  let hits: Hit[] = [];
  const { last, seen, empty } = await lastValues(r.id);

  if (r.kind === "date") {
    hits = dateHits(r, t, kyivNow(now).date).filter((h) => !seen.has(`${h.key}\u0000${h.value}`));
  } else {
    const ki = cols.indexOf(r.keyColumn);
    const si = cols.indexOf(r.statusColumn);
    const ci = cols.indexOf(r.contactColumn);
    if (ki < 0 || si < 0 || ci < 0) return res;
    const allowed = r.statusValues.map(norm).filter(Boolean);
    const baseline: { rowKey: string; value: string }[] = [];
    for (const row of t.rows) {
      const key = (row[ki] ?? "").trim();
      const value = (row[si] ?? "").trim();
      if (!key || !value || last.get(key) === value || seen.has(`${key}\u0000${value}`)) continue;
      // Первый проход и статусы, о которых не просили сообщать, — только запоминаем
      if (empty || (allowed.length && !allowed.includes(norm(value)))) baseline.push({ rowKey: key, value });
      else hits.push({ key, value, contact: (row[ci] ?? "").trim(), text: renderTemplate(r.message, cols, row) });
    }
    for (let i = 0; i < baseline.length; i += 200)
      await db.insert(reminderLog).values(baseline.slice(i, i + 200).map((b) => ({ reminderId: r.id, ...b, status: "seen" }))).onConflictDoNothing();
    if (empty) res.baseline = baseline.length;
  }

  for (const h of hits.slice(0, PER_RUN)) {
    // Сначала занимаем запись в журнале — второй параллельный проход не отправит то же самое
    const [slot] = await db.insert(reminderLog).values({ reminderId: r.id, rowKey: h.key, value: h.value, status: "sending", contact: h.contact.slice(0, 200) }).onConflictDoNothing().returning();
    if (!slot) continue;
    const text = h.text.trim();
    let status = "sent";
    let error: string | null = null;
    try {
      if (!text) throw new Error("empty_message");
      const out = await reach(r.clientId, parseContact(h.contact), { text, subject: r.name, mailChannelId: r.channelId, meta: { campaign: { id: r.id, name: r.name, step: 0 } } });
      status = out.status;
      if (out.status === "sent") res.sent++;
      else res.noChat.push(h.contact);
    } catch (e) {
      status = "failed";
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      res.failed++;
    }
    await db.update(reminderLog).set({ status, error }).where(eq(reminderLog.id, slot.id));
  }

  const summary = res.baseline != null ? `baseline ${res.baseline}` : `sent ${res.sent}, no chat ${res.noChat.length}, failed ${res.failed}`;
  await db.update(reminders).set({ lastRunAt: now, lastResult: summary }).where(eq(reminders.id, r.id));
  if (r.notifyTeam && (res.sent || res.noChat.length || res.failed)) {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = [
      `⏰ <b>${esc(r.name)}</b>`,
      `Отправлено напоминаний: ${res.sent}`,
      res.noChat.length ? `Не нашёл чат или почту (напишите сами): ${esc(res.noChat.slice(0, 30).join(", "))}` : "",
      res.failed ? `Ошибок отправки: ${res.failed}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const n = await import("@/lib/notify/telegram");
    await n.sendToTeam(html).catch(() => {});
    await n.sendToOwners(r.clientId, html).catch(() => {});
  }
  return res;
}

/** Раз в 10 минут: по дате — один раз в день начиная с часа напоминания; по статусу — каждый проход, кроме ночи. */
export async function remindersTick(now = new Date()) {
  const { quietUntil } = await import("@/lib/campaigns/engine");
  if (quietUntil(now)) return 0;
  const k = kyivNow(now);
  const list = await db.select().from(reminders).where(eq(reminders.enabled, true));
  let n = 0;
  for (const r of list) {
    if (r.kind === "date" && (k.hour < r.hour || (r.lastRunAt && kyivNow(r.lastRunAt).date === k.date))) continue;
    try {
      n += (await runReminder(r, now)).sent;
    } catch (e) {
      console.error("reminder failed", r.id, e);
      await db.update(reminders).set({ lastRunAt: now, lastResult: `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }).where(eq(reminders.id, r.id));
    }
  }
  return n;
}

/** Журнал последних отправок (для студии). */
export async function reminderHistory(reminderId: string, limit = 30) {
  return db
    .select({ rowKey: reminderLog.rowKey, value: reminderLog.value, status: reminderLog.status, contact: reminderLog.contact, error: reminderLog.error, createdAt: reminderLog.createdAt })
    .from(reminderLog)
    .where(and(eq(reminderLog.reminderId, reminderId), ne(reminderLog.status, "seen")))
    .orderBy(desc(reminderLog.createdAt))
    .limit(limit);
}

const g = globalThis as unknown as { __remindersTimer?: NodeJS.Timeout };
/** Напоминания по таблицам, повторные покупки и адаптация — раз в 10 минут. */
export function startReminders() {
  if (g.__remindersTimer) return;
  const tick = async () => {
    await remindersTick().catch((e) => console.error("reminders tick failed", e));
    await import("@/lib/repeat").then((m) => m.repeatTick()).catch((e) => console.error("repeat tick failed", e));
    await import("@/lib/onboarding").then((m) => m.onboardingTick()).catch((e) => console.error("onboarding tick failed", e));
  };
  g.__remindersTimer = setInterval(() => void tick(), 10 * 60_000);
  g.__remindersTimer.unref?.();
}
