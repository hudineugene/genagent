import "server-only";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { db } from "@/db";
import { channels, conversations, messages, type Channel, type EmailConfig } from "@/db/schema";
import { addMessage, scheduleReply, upsertConversation } from "@/lib/conversations";
import { smtpTransport } from "./email-send";

/**
 * Почта: раз в минуту читаем новые письма из «Входящих» по IMAP (не помечая прочитанными),
 * отвечаем по SMTP в ту же ветку. Рассылки, уведомления и автоответы пропускаем.
 */
const POLL_EVERY_MS = 60_000;
const MAX_PER_TICK = 20;
const MAX_BODY_CHARS = 8000;
/** Нет связи с сервером почты: тревога — только если опрос не проходит ~5 минут подряд; разовые таймауты — в журнал. */
const UNREACHABLE_ALERT_AFTER = 5;

export const GMAIL = { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 };

export class EmailError extends Error {
  constructor(public code: "auth_failed" | "unreachable", message?: string) {
    super(message ?? code);
  }
}

function imapClient(cfg: EmailConfig) {
  return new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.address, pass: cfg.password },
    logger: false,
    socketTimeout: 60_000,
  });
}

const isAuthError = (e: unknown) => {
  const x = e as { authenticationFailed?: boolean; responseCode?: number; code?: string; message?: string };
  return Boolean(x?.authenticationFailed) || x?.responseCode === 535 || x?.code === "EAUTH" || /auth/i.test(x?.message ?? "");
};

/** Проверка ящика при подключении: вход по IMAP и SMTP. */
export async function verifyEmail(cfg: EmailConfig) {
  const imap = imapClient(cfg);
  try {
    await imap.connect();
    await imap.logout();
  } catch (e) {
    throw new EmailError(isAuthError(e) ? "auth_failed" : "unreachable", e instanceof Error ? e.message : String(e));
  }
  try {
    await smtpTransport(cfg).verify();
  } catch (e) {
    throw new EmailError(isAuthError(e) ? "auth_failed" : "unreachable", e instanceof Error ? e.message : String(e));
  }
}

// ---------- входящие ----------

const g = globalThis as unknown as {
  __emailPoller?: ReturnType<typeof setInterval>;
  __emailLast?: Map<string, number>;
  __emailFails?: Map<string, number>;
};
const last = (g.__emailLast ??= new Map());
const fails = (g.__emailFails ??= new Map()); // неудачных опросов подряд по каналу
let running = false;

export function startEmailPolling() {
  if (g.__emailPoller) clearInterval(g.__emailPoller);
  g.__emailPoller = setInterval(() => void tick(), 15_000);
  g.__emailPoller.unref?.();
  void tick();
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const list = await db.select().from(channels).where(eq(channels.type, "email"));
    for (const ch of list) {
      if (!ch.enabled || Date.now() - (last.get(ch.id) ?? 0) < POLL_EVERY_MS) continue;
      last.set(ch.id, Date.now());
      try {
        await pollMailbox(ch);
        fails.delete(ch.id);
        if (ch.error) {
          await db.update(channels).set({ error: null }).where(eq(channels.id, ch.id));
          // О сбое сообщали — сообщаем и о восстановлении
          if (ch.error.startsWith("email_"))
            void import("@/lib/notify/telegram").then((n) => n.notifyRecovered(`channel:${ch.id}:${ch.error}`, ch.id, "почта снова работает"));
        }
      } catch (e) {
        console.error("email poll failed", ch.id, e);
        const code = isAuthError(e) ? "email_auth_failed" : "email_unreachable";
        const n = (fails.get(ch.id) ?? 0) + 1;
        fails.set(ch.id, n);
        // Пароль не приняли — само не пройдёт, сообщаем сразу; обрыв сети — только если затянулся
        if (code === "email_unreachable" && n < UNREACHABLE_ALERT_AFTER) continue;
        await db.update(channels).set({ error: code }).where(eq(channels.id, ch.id));
        if (ch.error !== code) void import("@/lib/notify/telegram").then((t) => t.notifyProblem(`channel:${ch.id}:${code}`, code, { channelId: ch.id }));
      }
    }
  } finally {
    running = false;
  }
}

/** Проверить ящик сейчас (после подключения). */
export function pollNow(channelId: string) {
  last.delete(channelId);
  void tick();
}

async function pollMailbox(ch: Channel) {
  const cfg = ch.config as EmailConfig;
  const imap = imapClient(cfg);
  await imap.connect();
  try {
    const box = await imap.mailboxOpen("INBOX", { readOnly: true });
    const validity = String(box.uidValidity);
    // Первый запуск (или ящик пересоздан): старые письма не трогаем, отвечаем только на новые.
    if (cfg.lastUid === undefined || cfg.uidValidity !== validity) {
      await saveCursor(ch.id, cfg, box.uidNext - 1, validity);
      return;
    }
    if (box.uidNext - 1 <= cfg.lastUid) return;

    let maxUid = cfg.lastUid;
    const batch: { uid: number; source: Buffer }[] = [];
    for await (const msg of imap.fetch(`${cfg.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= cfg.lastUid || !msg.source) continue; // «N:*» возвращает последнее письмо, даже если оно старое
      batch.push({ uid: msg.uid, source: msg.source });
      if (batch.length >= MAX_PER_TICK) break;
    }
    for (const m of batch.sort((a, b) => a.uid - b.uid)) {
      maxUid = Math.max(maxUid, m.uid);
      try {
        await handleIncoming(ch, cfg, await simpleParser(m.source));
      } catch (e) {
        console.error("email message failed", ch.id, m.uid, e);
      }
    }
    await saveCursor(ch.id, cfg, maxUid, validity);
  } finally {
    await imap.logout().catch(() => {});
  }
}

async function saveCursor(channelId: string, cfg: EmailConfig, lastUid: number, uidValidity: string) {
  // Перечитываем конфигурацию: за время проверки её могли изменить в интерфейсе.
  const [fresh] = await db.select({ config: channels.config }).from(channels).where(eq(channels.id, channelId));
  const base = (fresh?.config as EmailConfig | undefined) ?? cfg;
  await db.update(channels).set({ config: { ...base, lastUid, uidValidity } }).where(eq(channels.id, channelId));
}

const header = (m: ParsedMail, name: string) => {
  const v = m.headers.get(name);
  return typeof v === "string" ? v.toLowerCase() : v ? JSON.stringify(v).toLowerCase() : "";
};

/** Рассылки, уведомления сервисов и автоответы — не переписка с человеком. */
export function isAutomated(m: ParsedMail, from: string) {
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce|news(letter)?)[@+.-]/i.test(from)) return true;
  if (m.headers.has("list-id") || m.headers.has("list-unsubscribe")) return true;
  const auto = header(m, "auto-submitted");
  if (auto && auto !== "no") return true;
  if (/bulk|list|junk|auto_reply/.test(header(m, "precedence"))) return true;
  if (m.headers.has("x-autoreply") || m.headers.has("x-autorespond")) return true;
  return false;
}

/** Текст письма без процитированной переписки ниже. */
export function stripQuoted(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    // «On Mon, … wrote:», «… пише:», «… пишет:», разделитель «-----Original Message-----»
    if (/^(on .+wrote:|.+(пише|пишет|написав|написал|написала)\s*:)\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*(original message|forwarded message|пересланное сообщение|исходное сообщение)/i.test(line.trim())) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_BODY_CHARS);
}

async function seen(channelId: string, externalId: string) {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.channelId, channelId), eq(messages.externalId, externalId)))
    .limit(1);
  return Boolean(row);
}

export async function handleIncoming(ch: Channel, cfg: EmailConfig, m: ParsedMail) {
  const sender = m.from?.value[0];
  const from = sender?.address?.toLowerCase() ?? "";
  if (!from || from === cfg.address.toLowerCase() || isAutomated(m, from)) return;
  const messageId = m.messageId ?? `${from}:${m.date?.getTime() ?? Date.now()}`;
  if (await seen(ch.id, messageId)) return;

  const subject = (m.subject ?? "").trim();
  const body = stripQuoted(m.text ?? "") || "[письмо без текста]";
  const attachments = m.attachments.length ? `\n\n[вложений: ${m.attachments.length}]` : "";

  const { conversation, created } = await upsertConversation(ch, from, { name: sender?.name ?? "", handle: from });
  // Отвечаем на последнее письмо — запоминаем его Message-ID и цепочку для заголовков ответа.
  const refs = [...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : []), m.messageId].filter(Boolean).join(" ");
  await db
    .update(conversations)
    .set({ context: { ...conversation.context, subject, replyToId: m.messageId ?? undefined, references: refs || undefined, postText: subject } })
    .where(eq(conversations.id, conversation.id));

  const text = created || subject !== conversation.context?.subject ? `Тема: ${subject || "(без темы)"}\n\n${body}${attachments}` : `${body}${attachments}`;
  await addMessage(conversation.id, "user", text, { externalId: messageId });
  scheduleReply(conversation.id);
}
