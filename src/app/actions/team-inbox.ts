"use server";

import { refresh } from "next/cache";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { conversationNotes, conversations, users } from "@/db/schema";
import { requireOwned } from "@/lib/access";

/**
 * Командная работа в «Диалогах»: ответственный, метки, «отложить до…», внутренние заметки с @упоминаниями.
 * Всё — только по доступным сотруднику разговорам; агент и клиент этого не видят.
 */

const MAX_TAGS = 8;
const cleanTag = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 24);

/** Ответственный за разговор: id сотрудника студии или null — снять. */
export async function assignConversation(conversationId: string, userId: string | null): Promise<{ error?: string }> {
  await requireOwned("conversation", conversationId);
  if (userId) {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), ne(users.role, "client")));
    if (!u) return { error: "not_found" };
  }
  await db.update(conversations).set({ assigneeId: userId }).where(eq(conversations.id, conversationId));
  refresh();
  return {};
}

/** Ответственный — тот, кто нажал («Взять себе»). */
export async function assignToMe(conversationId: string) {
  const me = await requireOwned("conversation", conversationId);
  await db.update(conversations).set({ assigneeId: me.id }).where(eq(conversations.id, conversationId));
  refresh();
}

/** Метки разговора (до 8, по 24 символа, без повторов). */
export async function setConversationTags(conversationId: string, tags: string[]) {
  await requireOwned("conversation", conversationId);
  const list = [...new Set(tags.map(cleanTag).filter(Boolean))].slice(0, MAX_TAGS);
  await db.update(conversations).set({ tags: list }).where(eq(conversations.id, conversationId));
  refresh();
}

/** Отложить до времени (мс) или вернуть сразу (null). Новое сообщение клиента вернёт разговор раньше срока. */
export async function snoozeConversation(conversationId: string, until: number | null): Promise<{ error?: string }> {
  await requireOwned("conversation", conversationId);
  if (until !== null && (!Number.isFinite(until) || until <= Date.now() || until > Date.now() + 90 * 86_400_000)) return { error: "invalid" };
  await db
    .update(conversations)
    .set(until === null ? { snoozedUntil: null, snoozedAt: null } : { snoozedUntil: new Date(until), snoozedAt: new Date() })
    .where(eq(conversations.id, conversationId));
  refresh();
  return {};
}

/** Несколько разговоров разом (выбор в списке): закрыть, взять себе, прочитано. */
export async function bulkConversations(ids: string[], action: "close" | "mine" | "read") {
  const list = [...new Set(ids)].slice(0, 200);
  let me: Awaited<ReturnType<typeof requireOwned>> | null = null;
  for (const id of list) me = await requireOwned("conversation", id);
  if (!me || !list.length) return;
  const set = action === "close" ? { status: "closed" as const, needsAttention: false } : action === "mine" ? { assigneeId: me.id } : { unread: 0 };
  await db.update(conversations).set(set).where(inArray(conversations.id, list));
  refresh();
}

/** Сотрудники студии, упомянутые в тексте: «@Имя» или «@Имя Фамилия» (без учёта регистра). */
async function findMentions(text: string): Promise<string[]> {
  if (!text.includes("@")) return [];
  const staff = await db.select({ id: users.id, name: users.name }).from(users).where(ne(users.role, "client"));
  const low = text.toLowerCase();
  return staff
    .filter((u) => {
      const full = u.name.trim().toLowerCase();
      const first = full.split(/\s+/)[0];
      return Boolean(first) && (low.includes(`@${full}`) || new RegExp(`@${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u").test(low));
    })
    .map((u) => u.id);
}

/** Внутренняя заметка к разговору (до 2000 символов); упомянутые сотрудники увидят её в колокольчике. */
export async function addNote(conversationId: string, text: string): Promise<{ error?: string }> {
  const me = await requireOwned("conversation", conversationId);
  const body = text.trim().slice(0, 2000);
  if (!body) return { error: "empty" };
  await db.insert(conversationNotes).values({ conversationId, authorId: me.id, authorName: me.name, text: body, mentions: await findMentions(body) });
  refresh();
  return {};
}

/** Удалить свою заметку (администратор — любую). */
export async function deleteNote(noteId: string) {
  const [n] = await db.select({ conversationId: conversationNotes.conversationId, authorId: conversationNotes.authorId }).from(conversationNotes).where(eq(conversationNotes.id, noteId));
  if (!n) return;
  const me = await requireOwned("conversation", n.conversationId);
  if (n.authorId !== me.id && me.role !== "admin") return;
  await db.delete(conversationNotes).where(eq(conversationNotes.id, noteId));
  refresh();
}
