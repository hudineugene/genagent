import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, type MessageMeta } from "@/db/schema";

/**
 * Журнал переписки своего бота: бот присылает всё, что пришло от клиента и ушло клиенту (меню, ответы менеджеров,
 * уведомления, сообщения внутри своих сценариев…), — в «Диалогах» переписка полная. Без побочных действий:
 * режим диалога, «требует внимания», уведомления и ответ ИИ не трогаем.
 *
 * Дубли: у сообщения номер из бота (botId) — повторная досылка ничего не добавит. То, что уже есть в переписке
 * без номера (вопрос, пришедший к агенту, ответ агента, ответ менеджера из «Диалогов»), узнаём по тексту и времени
 * и только проставляем номер.
 */
export type SyncItem = {
  /** Номер в боте, уникальный в пределах клиента: "in:123", "out:456", "cb:…" */
  id: string;
  /** in — от клиента, out — клиенту */
  dir: "in" | "out";
  /** Для out: кто написал — агент (ответ ИИ), менеджер или сам бот (по умолчанию) */
  by?: "agent" | "manager" | "bot";
  text: string;
  /** photo, sticker, voice, video, document, location, contact, button, reaction… */
  kind?: string;
  /** Время сообщения, мс */
  at: number;
};

const MATCH_WINDOW_MS = 15 * 60 * 1000;

/** Сравнение без разметки, скобок и лишних пробелов. */
function norm(s: string) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameText(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Бот мог дописать строку к ответу агента (цена, подсказка) или отрезать хвост — достаточно, что одно внутри другого
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

function roleFor(item: SyncItem): "user" | "assistant" | "operator" | "bot" {
  if (item.dir === "in") return "user";
  return item.by === "agent" ? "assistant" : item.by === "manager" ? "operator" : "bot";
}

export async function syncBotMessages(conversationId: string, items: SyncItem[], { fresh = false }: { fresh?: boolean } = {}) {
  const result = { inserted: 0, matched: 0, skipped: 0 };
  if (!items.length) return result;
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const from = new Date(sorted[0].at - MATCH_WINDOW_MS);
  const to = new Date(sorted[sorted.length - 1].at + MATCH_WINDOW_MS);

  const existing = await db
    .select({ id: messages.id, role: messages.role, text: messages.text, botId: messages.botId, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), gte(messages.createdAt, from), lte(messages.createdAt, to)));
  const known = new Set(
    (await db.select({ botId: messages.botId }).from(messages).where(eq(messages.conversationId, conversationId)))
      .map((m) => m.botId)
      .filter(Boolean),
  );

  let latest: { at: number; text: string } | null = null;
  for (const item of sorted) {
    if (known.has(item.id)) {
      result.skipped++;
      continue;
    }
    const role = roleFor(item);
    // Кандидаты на «то же сообщение»: клиентское — среди клиентских; исходящее — среди ответов агента и менеджера
    const roles = role === "user" ? ["user"] : ["assistant", "operator", "bot"];
    const candidate = existing
      .filter((m) => !m.botId && roles.includes(m.role) && Math.abs(m.createdAt.getTime() - item.at) <= MATCH_WINDOW_MS && sameText(m.text, item.text))
      .sort((a, b) => Math.abs(a.createdAt.getTime() - item.at) - Math.abs(b.createdAt.getTime() - item.at))[0];
    if (candidate) {
      await db.update(messages).set({ botId: item.id }).where(eq(messages.id, candidate.id));
      candidate.botId = item.id;
      known.add(item.id);
      result.matched++;
      continue;
    }
    const meta: MessageMeta | undefined = item.kind && item.kind !== "text" ? { kind: item.kind } : undefined;
    const inserted = await db
      .insert(messages)
      .values({
        conversationId,
        role,
        text: item.text,
        meta,
        status: "sent",
        // Не пустой externalId: очередь /outbox не примет это за ответ, который надо отправить клиенту
        externalId: "bot",
        botId: item.id,
        createdAt: new Date(item.at),
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    known.add(item.id);
    if (!inserted.length) {
      result.skipped++;
      continue;
    }
    result.inserted++;
    if (!latest || item.at >= latest.at) latest = { at: item.at, text: item.text || `[${item.kind}]` };
  }

  // Последнее сообщение в списке диалогов — только если досланное новее того, что там уже есть
  if (latest) {
    const [conv] = await db.select({ lastMessageAt: conversations.lastMessageAt }).from(conversations).where(eq(conversations.id, conversationId));
    // Диалог только что создан досылкой — его «последнее сообщение» тоже из журнала, даже если оно старое
    if (conv && (fresh || latest.at > conv.lastMessageAt.getTime())) {
      await db
        .update(conversations)
        .set({ lastMessageAt: new Date(latest.at), lastMessageText: latest.text.slice(0, 200) })
        .where(eq(conversations.id, conversationId));
    }
  }
  return result;
}
