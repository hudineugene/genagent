import "server-only";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import {
  approvals,
  bookings,
  channels,
  clientDocuments,
  clients,
  contacts,
  conversations,
  formResponses,
  generatedDocs,
  learners,
  loyaltyAccounts,
  loyaltyTx,
  messages,
  payments,
  reminderLog,
  type Conversation,
} from "@/db/schema";
import { MEDIA_DIR } from "@/lib/media";

/**
 * Данные человека по GDPR: найти все его разговоры у клиента (по @нику, id чата, телефону, почте), выгрузить всё
 * одним файлом (ст. 15, 20) или удалить всё, включая файлы (ст. 17). Сроки хранения: разговоры старше N дней
 * удаляются сами (ст. 5(1)(e)).
 */
const norm = (s: string) => s.trim().replace(/^@/, "").toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "");

/** Все разговоры этого человека у клиента. */
export async function personConversations(conversationId: string) {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!c) return { person: null, list: [] as Conversation[] };
  const all = await db.select().from(conversations).where(eq(conversations.clientId, c.clientId));
  const handle = norm(c.contactHandle);
  const ext = c.externalId.toLowerCase();
  const phone = digits(c.externalId).length >= 9 ? digits(c.externalId).slice(-9) : "";
  const list = all.filter(
    (x) =>
      x.id === c.id ||
      (handle && norm(x.contactHandle) === handle) ||
      (x.channelType === c.channelType && x.externalId.toLowerCase() === ext) ||
      (ext.includes("@") && x.externalId.toLowerCase() === ext) ||
      (phone && digits(x.externalId).endsWith(phone)),
  );
  return { person: c, list };
}

/** Ключи человека для поиска в списках и баллах: ник, почта, телефон, id чатов. */
function keysOf(list: Conversation[]) {
  const out = new Set<string>();
  for (const c of list) {
    if (c.contactHandle) out.add(norm(c.contactHandle));
    if (c.externalId) out.add(c.externalId.toLowerCase());
    if (digits(c.externalId).length >= 9) out.add(digits(c.externalId));
  }
  return [...out].filter(Boolean);
}

/** Всё о человеке одним объектом (для выгрузки JSON). */
export async function exportPerson(conversationId: string) {
  const { person, list } = await personConversations(conversationId);
  if (!person) return null;
  const ids = list.map((c) => c.id);
  const keys = keysOf(list);
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, person.clientId));
  const chans = await db.select({ id: channels.id, type: channels.type, name: channels.name }).from(channels).where(inArray(channels.id, [...new Set(list.map((c) => c.channelId))]));
  const msgs = ids.length ? await db.select().from(messages).where(inArray(messages.conversationId, ids)).orderBy(asc(messages.createdAt)) : [];
  const [forms, docs, gen, books, accs, learn, lists, appr, pays] = await Promise.all([
    ids.length ? db.select().from(formResponses).where(inArray(formResponses.conversationId, ids)) : [],
    ids.length ? db.select().from(clientDocuments).where(inArray(clientDocuments.conversationId, ids)) : [],
    ids.length ? db.select().from(generatedDocs).where(inArray(generatedDocs.conversationId, ids)) : [],
    ids.length ? db.select().from(bookings).where(inArray(bookings.conversationId, ids)) : [],
    db.select().from(loyaltyAccounts).where(or(...(ids.length ? [inArray(loyaltyAccounts.conversationId, ids)] : []), ...(keys.length ? [inArray(loyaltyAccounts.contact, keys)] : []))),
    db.select().from(learners).where(and(eq(learners.clientId, person.clientId), or(...(ids.length ? [inArray(learners.conversationId, ids)] : []), ...(keys.length ? [inArray(learners.contact, keys)] : [])))),
    contactRows(person.clientId, keys),
    ids.length ? db.select().from(approvals).where(inArray(approvals.conversationId, ids)) : [],
    ids.length ? db.select().from(payments).where(inArray(payments.conversationId, ids)) : [],
  ]);
  const tx = accs.length ? await db.select().from(loyaltyTx).where(inArray(loyaltyTx.accountId, accs.map((a) => a.id))) : [];
  const chanName = new Map(chans.map((c) => [c.id, `${c.type}: ${c.name}`]));
  return {
    exportedAt: new Date().toISOString(),
    controller: client?.name ?? "",
    person: { name: person.contactName, handle: person.contactHandle },
    conversations: list.map((c) => ({
      channel: chanName.get(c.channelId) ?? c.channelType,
      externalId: c.externalId,
      startedAt: c.createdAt.toISOString(),
      lastMessageAt: c.lastMessageAt.toISOString(),
      language: c.context?.language ?? null,
      memory: c.context?.memory?.facts ?? [],
      leadCard: c.context?.lead ? { temperature: c.context.lead.temperature, fields: c.context.lead.fields } : null,
      messages: msgs
        .filter((m) => m.conversationId === c.id && m.role !== "system")
        .map((m) => ({ at: m.createdAt.toISOString(), from: m.role === "user" ? "person" : m.role, text: m.text })),
    })),
    formResponses: forms.map((f) => ({ at: f.createdAt.toISOString(), answers: f.answers })),
    documents: docs.map((d) => ({ at: d.createdAt.toISOString(), filename: d.filename, fields: d.fields, summary: d.summary })),
    issuedDocuments: gen.map((d) => ({ at: d.createdAt.toISOString(), title: d.title, body: d.body })),
    bookings: books.map((b) => ({ startsAt: b.startsAt.toISOString(), service: b.service })),
    loyalty: accs.map((a) => ({ name: a.name, balance: a.balance, history: tx.filter((t) => t.accountId === a.id).map((t) => ({ at: t.createdAt.toISOString(), delta: t.delta, reason: t.reason })) })),
    learning: learn.map((l) => ({ goal: l.goal, level: l.level, points: l.points, results: l.results })),
    contactLists: lists.map((x) => ({ name: x.name, email: x.email, telegram: x.telegram, phone: x.phone, company: x.company, fields: x.fields, unsubscribed: x.unsubscribed })),
    requests: appr.map((a) => ({ at: a.createdAt.toISOString(), subject: a.subject, status: a.status })),
    payments: pays.map((x) => ({ at: x.createdAt.toISOString(), amount: x.amount, currency: x.currency, description: x.description, status: x.status })),
  };
}

async function contactRows(clientId: string, keys: string[]) {
  if (!keys.length) return [];
  const rows = await db.select().from(contacts).where(eq(contacts.clientId, clientId));
  return rows.filter((r) => keys.includes(r.email) || keys.includes(norm(r.telegram)) || (digits(r.phone).length >= 9 && keys.some((k) => k.endsWith(digits(r.phone).slice(-9)))));
}

/** Удалить файлы, связанные с разговорами: превью фото сообщений, файлы архива документов. */
async function removeFiles(ids: string[]) {
  if (!ids.length) return 0;
  let n = 0;
  const thumbs = await db.select({ meta: messages.meta }).from(messages).where(and(inArray(messages.conversationId, ids), isNotNull(messages.meta)));
  for (const t of thumbs) {
    const name = t.meta?.thumb;
    if (name && /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(name)) {
      fs.rmSync(path.join(MEDIA_DIR, name), { force: true });
      n++;
    }
  }
  const docs = await db.select({ file: clientDocuments.file }).from(clientDocuments).where(inArray(clientDocuments.conversationId, ids));
  const { removeArchived } = await import("@/lib/documents/archive");
  for (const d of docs) {
    if (!d.file) continue;
    removeArchived(d.file);
    n++;
  }
  return n;
}

/** Удалить разговоры вместе со всем, что к ним привязано. */
export async function deleteConversations(ids: string[]) {
  if (!ids.length) return { conversations: 0, files: 0 };
  const files = await removeFiles(ids);
  await db.delete(formResponses).where(inArray(formResponses.conversationId, ids));
  await db.delete(clientDocuments).where(inArray(clientDocuments.conversationId, ids));
  await db.delete(generatedDocs).where(inArray(generatedDocs.conversationId, ids));
  await db.delete(bookings).where(inArray(bookings.conversationId, ids));
  await db.delete(approvals).where(inArray(approvals.conversationId, ids));
  await db.delete(conversations).where(inArray(conversations.id, ids));
  return { conversations: ids.length, files };
}

/** Право на удаление: все разговоры человека у клиента, баллы, обучение, записи в списках, журнал напоминаний. */
export async function erasePerson(conversationId: string) {
  const { person, list } = await personConversations(conversationId);
  if (!person) return null;
  const ids = list.map((c) => c.id);
  const keys = keysOf(list);
  if (keys.length) {
    await db.delete(loyaltyAccounts).where(or(inArray(loyaltyAccounts.conversationId, ids), inArray(loyaltyAccounts.contact, keys)));
    await db.delete(learners).where(and(eq(learners.clientId, person.clientId), or(inArray(learners.conversationId, ids), inArray(learners.contact, keys))));
    const rows = await contactRows(person.clientId, keys);
    if (rows.length) await db.delete(contacts).where(inArray(contacts.id, rows.map((r) => r.id)));
    const handles = keys.flatMap((k) => [k, `@${k}`]);
    await db.delete(reminderLog).where(inArray(reminderLog.contact, handles));
  }
  const r = await deleteConversations(ids);
  return { ...r, name: person.contactName };
}

/** Сроки хранения: у клиентов с заданным сроком удалить разговоры, где последнее сообщение старше N дней. */
export async function retentionTick(now = Date.now()) {
  const list = await db.select({ id: clients.id, days: clients.retentionDays }).from(clients).where(isNotNull(clients.retentionDays));
  let removed = 0;
  for (const c of list) {
    if (!c.days || c.days < 1) continue;
    const old = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clientId, c.id), lt(conversations.lastMessageAt, new Date(now - c.days * 86400_000))))
      .limit(500);
    if (old.length) removed += (await deleteConversations(old.map((x) => x.id))).conversations;
  }
  return removed;
}
