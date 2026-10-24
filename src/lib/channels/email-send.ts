import "server-only";
import nodemailer from "nodemailer";
import type { Conversation, EmailConfig } from "@/db/schema";

// Отправка писем отдельно от чтения ящика: её вызывает доставка ответов (conversations.ts).

/** Письма, «отправленные» в тестах (EMAIL_TEST_JSON=1): ничего не уходит в сеть, письмо остаётся здесь. */
export const testOutbox: { to: string; subject: string; text: string; from: string }[] = [];

export function smtpTransport(cfg: EmailConfig) {
  if (process.env.EMAIL_TEST_JSON === "1") {
    return {
      sendMail: async (m: { to: string; subject: string; text: string; from: { address: string } }) => {
        testOutbox.push({ to: m.to, subject: m.subject, text: m.text, from: m.from.address });
        return { messageId: `<test-${testOutbox.length}@local>` };
      },
    } as unknown as ReturnType<typeof nodemailer.createTransport>;
  }
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpPort === 465,
    auth: { user: cfg.address, pass: cfg.password },
    connectionTimeout: 20_000,
  });
}

/** Ответ в ту же ветку: тема «Re: …», заголовки In-Reply-To и References. */
export async function sendEmailReply(cfg: EmailConfig, conversation: Pick<Conversation, "externalId" | "context">, text: string) {
  const subject = conversation.context?.subject ?? "";
  const info = await smtpTransport(cfg).sendMail({
    from: { name: cfg.fromName || cfg.address, address: cfg.address },
    to: conversation.externalId,
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject || "ваш запит"}`,
    text,
    ...(conversation.context?.replyToId
      ? { inReplyTo: conversation.context.replyToId, references: conversation.context.references ?? conversation.context.replyToId }
      : {}),
  });
  return info.messageId ?? null;
}
