"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientRepeat, dataTables, reminders } from "@/db/schema";
import { requireUser } from "@/lib/auth";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  tableId: z.string().min(1).max(64),
  kind: z.enum(["date", "status"]),
  dateColumn: z.string().max(200),
  offsetDays: z.number().int().min(-60).max(365),
  keyColumn: z.string().max(200),
  statusColumn: z.string().max(200),
  statusValues: z.array(z.string().trim().min(1).max(100)).max(30),
  contactColumn: z.string().min(1).max(200),
  channelId: z.string().max(64).nullable(),
  message: z.string().trim().min(1).max(3000),
  hour: z.number().int().min(8).max(21),
  notifyTeam: z.boolean(),
  enabled: z.boolean(),
});

export async function saveReminder(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<{ error?: string; id?: string }> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const [t] = await db.select({ columns: dataTables.columns }).from(dataTables).where(and(eq(dataTables.id, d.tableId), eq(dataTables.clientId, clientId)));
  if (!t) return { error: "table" };
  const cols = new Set(t.columns.map((c) => c.name));
  if (!cols.has(d.contactColumn)) return { error: "columns" };
  if (d.kind === "date" && !cols.has(d.dateColumn)) return { error: "columns" };
  if (d.kind === "status" && (!cols.has(d.keyColumn) || !cols.has(d.statusColumn))) return { error: "columns" };
  const values = { ...d, channelId: d.channelId || null, updatedAt: new Date() };
  if (id) {
    await db.update(reminders).set(values).where(and(eq(reminders.id, id), eq(reminders.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(reminders).values({ clientId, ...values }).returning({ id: reminders.id });
  refresh();
  return { id: row.id };
}

export async function deleteReminder(id: string) {
  await requireUser();
  await db.delete(reminders).where(eq(reminders.id, id));
  refresh();
}

/** Выполнить сейчас (настоящая отправка тем, кому пора). */
export async function runReminderNow(id: string) {
  await requireUser();
  const [r] = await db.select().from(reminders).where(eq(reminders.id, id));
  if (!r) return { error: "not_found" };
  const { runReminder } = await import("@/lib/reminders");
  const res = await runReminder(r);
  refresh();
  return res;
}

export async function reminderLogAction(id: string) {
  await requireUser();
  const { reminderHistory } = await import("@/lib/reminders");
  return (await reminderHistory(id)).map((x) => ({ ...x, createdAt: x.createdAt.getTime() }));
}

/** Предпросмотр: кому и что ушло бы сегодня (по дате) — без отправки. */
export async function previewReminder(clientId: string, input: z.input<typeof schema>) {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== "date") return [];
  const [raw] = await db.select().from(dataTables).where(and(eq(dataTables.id, parsed.data.tableId), eq(dataTables.clientId, clientId)));
  if (!raw) return [];
  const { refreshTable } = await import("@/lib/data/tables");
  const { dateHits } = await import("@/lib/reminders");
  const { kyivNow } = await import("@/lib/reach");
  return dateHits(parsed.data, await refreshTable(raw), kyivNow().date).slice(0, 20);
}

// ---------- повторные покупки ----------

const repeatSchema = z.object({
  tableId: z.string().min(1).max(64),
  customerColumn: z.string().min(1).max(200),
  dateColumn: z.string().min(1).max(200),
  contactColumn: z.string().max(200),
  productColumn: z.string().max(200),
  amountColumn: z.string().max(200),
  leadDays: z.number().int().min(0).max(60),
  minOrders: z.number().int().min(2).max(50),
  auto: z.boolean(),
  brief: z.string().trim().max(1000),
  channelId: z.string().max(64).nullable(),
  hour: z.number().int().min(8).max(21),
});

export async function saveRepeat(clientId: string, input: z.input<typeof repeatSchema>): Promise<{ error?: string }> {
  await requireUser();
  const parsed = repeatSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = { ...parsed.data, channelId: parsed.data.channelId || null };
  const [t] = await db.select({ columns: dataTables.columns }).from(dataTables).where(and(eq(dataTables.id, d.tableId), eq(dataTables.clientId, clientId)));
  if (!t) return { error: "table" };
  const cols = new Set(t.columns.map((c) => c.name));
  if (!cols.has(d.customerColumn) || !cols.has(d.dateColumn)) return { error: "columns" };
  if (d.auto && !cols.has(d.contactColumn)) return { error: "contact" };
  await db
    .insert(clientRepeat)
    .values({ clientId, ...d, updatedAt: new Date() })
    .onConflictDoUpdate({ target: clientRepeat.clientId, set: { ...d, updatedAt: new Date() } });
  refresh();
  return {};
}

export async function runRepeatNow(clientId: string) {
  await requireUser();
  const { runRepeat } = await import("@/lib/repeat");
  const r = await runRepeat(clientId);
  refresh();
  return r;
}

/** Список «пора покупать» → список контактов для «Писем по спискам» (группа — статус прогноза). */
export async function repeatToContacts(clientId: string): Promise<{ error?: string; count?: number }> {
  await requireUser();
  const { loadRepeat, predictRepeat } = await import("@/lib/repeat");
  const { kyivNow } = await import("@/lib/reach");
  const found = await loadRepeat(clientId);
  if (!found) return { error: "not_configured" };
  const list = predictRepeat(found.cfg, found.table, kyivNow().date).filter((c) => c.status !== "later" && c.contact);
  if (!list.length) return { error: "empty" };
  const { importContacts } = await import("@/lib/outreach/engine");
  const rows = list.map((c) => [c.customer, c.contact, c.status === "due" ? "пора покупать" : c.status === "late" ? "просрочил" : "уходит", String(c.orders), c.lastDate, c.products.join(", ")]);
  // Контакт может быть почтой, @ником или телефоном — раскладываем по своим столбцам
  const { parseContact } = await import("@/lib/reach");
  const split = rows.map((r) => {
    const k = parseContact(r[1]);
    return [r[0], k.email, k.telegram, k.phone, r[2], r[3], r[4], r[5]];
  });
  const { count } = await importContacts(clientId, `Повторные покупки ${kyivNow().date}`, ["Имя", "Email", "Telegram", "Телефон", "Группа", "Заказов", "Последний заказ", "Обычно берёт"], split, "repeat");
  refresh();
  return { count };
}
