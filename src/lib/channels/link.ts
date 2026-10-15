import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, type Channel, type Conversation } from "@/db/schema";
import { addMessage, upsertConversation } from "@/lib/conversations";

/**
 * Один разговор на сайте и в боте: посетитель виджета нажимает «Продолжить в Telegram» — получает ссылку
 * t.me/<бот>?start=w_<код>. Свой бот клиента передаёт код в GenAgent (/link), и переписка с сайта переносится
 * в разговор бота — агент продолжает с того же места, а в «Диалогах» видно, откуда пришёл клиент.
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COPY_LIMIT = 30;

/** Код для ссылки (переиспользуется, пока действует). */
export async function widgetLinkToken(conversation: Conversation) {
  const ctx = conversation.context ?? {};
  if (ctx.linkToken && ctx.linkAt && Date.now() - ctx.linkAt < TOKEN_TTL_MS) return ctx.linkToken;
  const token = randomBytes(15).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  await db
    .update(conversations)
    .set({ context: { ...ctx, linkToken: token, linkAt: Date.now() } })
    .where(eq(conversations.id, conversation.id));
  return token;
}

export type LinkResult = { linked: false } | { linked: true; conversationId: string; copied: number };

/** Перенести разговор с сайта в разговор своего бота (тот же клиент студии). Код одноразовый. */
export async function linkWidgetConversation(
  apiChannel: Channel,
  token: string,
  user: { id: string; name?: string; handle?: string },
): Promise<LinkResult> {
  const candidates = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.clientId, apiChannel.clientId), eq(conversations.channelType, "widget")));
  const source = candidates.find((c) => c.context?.linkToken === token && c.context.linkAt && Date.now() - c.context.linkAt < TOKEN_TTL_MS);
  if (!source) return { linked: false };

  const { conversation: target } = await upsertConversation(apiChannel, user.id, { name: user.name, handle: user.handle });
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, source.id), inArray(messages.role, ["user", "assistant", "operator"]), eq(messages.status, "sent")))
    .orderBy(asc(messages.createdAt));
  const copy = rows.slice(-COPY_LIMIT);
  if (copy.length) {
    // Со своим временем — история идёт до разговора в боте; externalId «site» — очередь /outbox их не трогает.
    await db.insert(messages).values(
      copy.map((m) => ({
        conversationId: target.id,
        role: m.role,
        text: m.text,
        status: "sent" as const,
        externalId: "site",
        meta: { ...(m.meta ?? {}), fromSite: true },
        createdAt: m.createdAt,
      })),
    );
  }
  await addMessage(target.id, "system", "linked_widget", { externalId: "site" });
  await db
    .update(conversations)
    .set({ context: { ...(source.context ?? {}), linkToken: undefined, linkAt: undefined, linkedTo: target.id } })
    .where(eq(conversations.id, source.id));
  await addMessage(source.id, "system", "linked_bot", { externalId: "site" });
  await db
    .update(conversations)
    .set({ context: { ...(target.context ?? {}), linkedFrom: source.id } })
    .where(eq(conversations.id, target.id));
  return { linked: true, conversationId: target.id, copied: copy.length };
}
