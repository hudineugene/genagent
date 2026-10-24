"use server";

import { refresh } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channels, contactLists, contacts, outreach, outreachMessages } from "@/db/schema";
import { generateOutreach, importContacts } from "@/lib/outreach/engine";

import { requireClient, requireClientAnd, requireOwned } from "@/lib/access";
/** Список контактов из Google Таблицы (доступ — сервисному аккаунту студии, как для «Данных»). */
export async function importSheetList(clientId: string, input: { name: string; url: string; sheet: string }): Promise<{ error?: string; count?: number }> {
  await requireClient(clientId);
  const { readValues, spreadsheetId } = await import("@/lib/google/sheets");
  const id = spreadsheetId(input.url);
  if (!id) return { error: "sheet_url" };
  try {
    const [header, ...rows] = (await readValues(id, input.sheet.trim(), "A1:Z5000")).filter((r) => r.some((c) => String(c).trim()));
    if (!header || !rows.length) return { error: "empty" };
    const r = await importContacts(clientId, input.name.trim() || "Google Таблица", header, rows, "sheet");
    refresh();
    return { count: r.count };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { error: m === "empty" ? "no_contacts" : m.slice(0, 200) };
  }
}

export async function deleteContactList(id: string) {
  await requireOwned("contactList", id);
  await db.delete(contactLists).where(eq(contactLists.id, id));
  refresh();
}

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  listId: z.string().min(1),
  mode: z.enum(["email", "chats"]),
  channelId: z.string().nullable(),
  brief: z.string().trim().min(5).max(3000),
  groupBriefs: z.record(z.string(), z.string().trim().max(2000)),
  research: z.boolean(),
});

export async function saveOutreach(clientId: string, id: string | null, input: z.input<typeof schema>): Promise<{ error?: string; id?: string }> {
  await requireClientAnd(clientId, "outreach", id);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  if (d.mode === "email") {
    const [ch] = d.channelId ? await db.select({ type: channels.type, clientId: channels.clientId }).from(channels).where(eq(channels.id, d.channelId)) : [];
    if (ch?.type !== "email" || ch.clientId !== clientId) return { error: "no_channel" };
  }
  const values = { ...d, channelId: d.mode === "email" ? d.channelId : null, groupBriefs: Object.fromEntries(Object.entries(d.groupBriefs).filter(([, v]) => v)), updatedAt: new Date() };
  if (id) {
    await db.update(outreach).set(values).where(and(eq(outreach.id, id), eq(outreach.clientId, clientId)));
    refresh();
    return { id };
  }
  const [row] = await db.insert(outreach).values({ clientId, ...values }).returning({ id: outreach.id });
  refresh();
  return { id: row.id };
}

/** Подготовить письма (в фоне): исследование и черновик для каждого контакта. */
export async function generateOutreachAction(id: string) {
  await requireOwned("outreach", id);
  await db.update(outreach).set({ status: "generating", updatedAt: new Date() }).where(eq(outreach.id, id));
  void generateOutreach(id).catch(async (e) => {
    console.error("outreach generation failed", e);
    await db.update(outreach).set({ status: "review", error: e instanceof Error ? e.message : String(e) }).where(eq(outreach.id, id));
  });
  refresh();
}

export async function getOutreachMessages(id: string) {
  await requireOwned("outreach", id);
  const rows = await db
    .select({ m: outreachMessages, c: contacts })
    .from(outreachMessages)
    .innerJoin(contacts, eq(contacts.id, outreachMessages.contactId))
    .where(eq(outreachMessages.outreachId, id))
    .limit(500);
  return rows.map(({ m, c }) => ({
    id: m.id,
    status: m.status,
    subject: m.subject,
    body: m.body,
    research: m.research,
    error: m.error,
    contact: { name: c.name, email: c.email, telegram: c.telegram, company: c.company, grp: c.grp },
  }));
}

const msgSchema = z.object({ subject: z.string().trim().max(200), body: z.string().trim().min(1).max(6000) });

export async function saveOutreachMessage(id: string, input: z.input<typeof msgSchema>): Promise<{ error?: string }> {
  await requireOwned("outreachMessage", id);
  const parsed = msgSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  await db.update(outreachMessages).set(parsed.data).where(and(eq(outreachMessages.id, id), inArray(outreachMessages.status, ["ready", "approved", "failed", "skipped"])));
  return {};
}

export async function setOutreachMessageStatus(id: string, status: "approved" | "skipped" | "ready") {
  await requireOwned("outreachMessage", id);
  await db.update(outreachMessages).set({ status }).where(and(eq(outreachMessages.id, id), inArray(outreachMessages.status, ["ready", "approved", "skipped"])));
}

/** Одобрить все готовые черновики. */
export async function approveAllOutreach(id: string) {
  await requireOwned("outreach", id);
  await db.update(outreachMessages).set({ status: "approved" }).where(and(eq(outreachMessages.outreachId, id), eq(outreachMessages.status, "ready")));
  refresh();
}

/** Начать или приостановить отправку одобренных писем. */
export async function setOutreachSending(id: string, on: boolean): Promise<{ error?: string }> {
  await requireOwned("outreach", id);
  if (on) {
    const [left] = await db.select({ id: outreachMessages.id }).from(outreachMessages).where(and(eq(outreachMessages.outreachId, id), eq(outreachMessages.status, "approved"))).limit(1);
    if (!left) return { error: "nothing_approved" };
  }
  await db.update(outreach).set({ status: on ? "sending" : "review", updatedAt: new Date() }).where(eq(outreach.id, id));
  refresh();
  return {};
}

export async function deleteOutreach(id: string) {
  await requireOwned("outreach", id);
  await db.delete(outreach).where(eq(outreach.id, id));
  refresh();
}
