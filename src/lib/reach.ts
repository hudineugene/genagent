import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, conversations, type EmailConfig } from "@/db/schema";
import { studioTz } from "@/lib/general";

/**
 * Написать человеку первым по контакту из таблицы или карточки: существующий чат в каналах клиента (по @нику,
 * телефону или почте), иначе — письмо с почтового канала клиента (разговор создаётся, ответ увидит агент).
 * Отписавшимся («стоп») не пишем.
 */
export type ContactKeys = { telegram: string; phone: string; email: string };

/** Строка контакта → ключи: «@ivan», «t.me/ivan», «+380 67…», «a@b.c»; можно несколько через запятую. */
export function parseContact(raw: string): ContactKeys {
  const out: ContactKeys = { telegram: "", phone: "", email: "" };
  for (const part of raw.split(/[,;\n]/)) {
    const s = part.trim();
    if (!s) continue;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) out.email ||= s.toLowerCase();
    else if (/^(https?:\/\/)?t\.me\//i.test(s)) out.telegram ||= `@${s.replace(/^(https?:\/\/)?t\.me\//i, "").replace(/\/.*$/, "")}`;
    else if (s.startsWith("@")) out.telegram ||= s;
    else if (/^\+?[\d\s()-]{9,}$/.test(s)) out.phone ||= s.replace(/\D/g, "");
    else if (/^[a-z][a-z0-9_]{4,31}$/i.test(s)) out.telegram ||= `@${s}`;
  }
  return out;
}

/** Найти разговор с человеком в каналах клиента (сначала самый свежий). */
export async function findChat(clientId: string, c: ContactKeys) {
  const list = await db
    .select({ conv: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(and(eq(conversations.clientId, clientId), eq(conversations.isTest, false), eq(channels.enabled, true)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(5000);
  const tg = c.telegram.replace(/^@/, "").toLowerCase();
  const phone = c.phone.replace(/\D/g, "");
  return (
    list.find(
      (r) =>
        (tg && r.conv.contactHandle.replace(/^@/, "").toLowerCase() === tg) ||
        (phone.length >= 9 && r.conv.externalId.replace(/\D/g, "").endsWith(phone.slice(-9))) ||
        (c.email && r.conv.externalId.toLowerCase() === c.email),
    ) ?? null
  );
}

export type ReachResult = { status: "sent"; via: "chat" | "email"; conversationId: string } | { status: "no_chat" | "unsubscribed" };

/**
 * Отправить сообщение: в чат или (нет чата, есть почта и почтовый канал) письмом. meta — пометка в истории
 * (например, { campaign: { id, name, step } }), чтобы было видно, откуда сообщение.
 */
export async function reach(
  clientId: string,
  contact: ContactKeys,
  msg: { text: string; subject?: string; name?: string; mailChannelId?: string | null; meta?: Record<string, unknown> },
): Promise<ReachResult> {
  const { addMessage, deliver, upsertConversation } = await import("@/lib/conversations");
  const found = await findChat(clientId, contact);
  if (found) {
    if (found.conv.context?.optOut) return { status: "unsubscribed" };
    const externalId = await deliver(found.channel, found.conv, msg.text);
    await addMessage(found.conv.id, "assistant", msg.text, { externalId: externalId ?? undefined, meta: msg.meta as never });
    return { status: "sent", via: "chat", conversationId: found.conv.id };
  }
  if (!contact.email || !msg.mailChannelId) return { status: "no_chat" };
  const [ch] = await db.select().from(channels).where(and(eq(channels.id, msg.mailChannelId), eq(channels.clientId, clientId)));
  if (!ch || ch.type !== "email") return { status: "no_chat" };
  const { conversation } = await upsertConversation(ch, contact.email, { name: msg.name ?? "", handle: contact.email });
  if (conversation.context?.optOut) return { status: "unsubscribed" };
  const cfg = ch.config as EmailConfig;
  const subject = (msg.subject || msg.text.split("\n")[0]).slice(0, 120);
  const { smtpTransport } = await import("@/lib/channels/email-send");
  const info = await smtpTransport(cfg).sendMail({ from: { name: cfg.fromName || cfg.address, address: cfg.address }, to: contact.email, subject, text: msg.text });
  await db.update(conversations).set({ context: { ...conversation.context, subject } }).where(eq(conversations.id, conversation.id));
  await addMessage(conversation.id, "assistant", msg.text, { externalId: info.messageId ?? undefined, meta: msg.meta as never });
  return { status: "sent", via: "email", conversationId: conversation.id };
}

/** Сегодня по Киеву: дата ГГГГ-ММ-ДД и час. */
export function kyivNow(at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: studioTz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Разница в днях между датами ГГГГ-ММ-ДД (b − a). */
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
}

export function addDays(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}
