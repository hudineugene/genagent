import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Удачные ответы как образец стиля. Раз в сутки (после утренней проверки) для каждого агента — до 5 ответов,
 * которые понравились клиентам (👍) или прошли утреннюю проверку без замечаний: тон, длина, структура.
 * Они добавляются в инструкцию агента («подражай тону, факты — только из базы знаний»). Передачи менеджеру,
 * напоминания, тестовые разговоры и ответы с контактами не берём. В настройках агента их видно, любой можно убрать.
 */
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_EXAMPLES = 5;
const MIN_LEN = 40;
const MAX_LEN = 600;

export type AnswerExample = { id: string; question: string; answer: string; liked: boolean };
type Stored = { items: AnswerExample[]; hidden: string[]; at: number };

const key = (agentId: string) => `examples:${agentId}`;
// Телефоны, почта, ссылки — такие ответы в образцы не берём
const PRIVATE_RE = /(\+?\d[\d\s()-]{8,}\d)|([^\s@]+@[^\s@]+\.[a-z]{2,})|(https?:\/\/)/i;

export async function getExamples(agentId: string): Promise<AnswerExample[]> {
  return (await getSetting<Stored>(key(agentId)))?.items ?? [];
}

/** Пересобрать образцы агента. Возвращает их число. */
export async function refreshExamples(agentId: string): Promise<number> {
  const stored = await getSetting<Stored>(key(agentId));
  const hidden = new Set(stored?.hidden ?? []);
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false), eq(conversations.kind, "dm"), gt(conversations.lastMessageAt, new Date(Date.now() - WINDOW_MS))));
  const items: (AnswerExample & { score: number; at: number })[] = [];
  if (convs.length) {
    const rows = await db
      .select({ id: messages.id, conversationId: messages.conversationId, role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
      .from(messages)
      .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"])))
      .orderBy(asc(messages.createdAt));
    const lastQ = new Map<string, string>();
    for (const m of rows) {
      if (m.role === "user") {
        if (m.text.trim()) lastQ.set(m.conversationId, m.text.trim());
        continue;
      }
      if (m.role === "operator") {
        lastQ.delete(m.conversationId);
        continue;
      }
      const q = lastQ.get(m.conversationId);
      lastQ.delete(m.conversationId);
      const meta = m.meta ?? {};
      const liked = meta.rating === "up";
      const checked = meta.qa?.ok === true;
      if (!q || hidden.has(m.id) || (!liked && !checked) || meta.handoff || meta.followUp || meta.orderNote || meta.rating === "down") continue;
      const answer = m.text.trim();
      if (answer.length < MIN_LEN || answer.length > MAX_LEN || q.length > 300 || PRIVATE_RE.test(answer) || PRIVATE_RE.test(q)) continue;
      items.push({ id: m.id, question: q, answer, liked, score: (liked ? 3 : 1) + m.createdAt.getTime() / 1e13, at: m.createdAt.getTime() });
    }
  }
  // Лучшие и разные: не два ответа на один и тот же вопрос
  items.sort((a, b) => b.score - a.score);
  const picked: AnswerExample[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const sig = it.question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 40);
    if (seen.has(sig)) continue;
    seen.add(sig);
    picked.push({ id: it.id, question: it.question, answer: it.answer, liked: it.liked });
    if (picked.length >= MAX_EXAMPLES) break;
  }
  await setSetting(key(agentId), { items: picked, hidden: [...hidden], at: Date.now() } satisfies Stored);
  return picked.length;
}

/** Убрать образец (и больше не брать этот ответ). */
export async function hideExample(agentId: string, messageId: string) {
  const stored = (await getSetting<Stored>(key(agentId))) ?? { items: [], hidden: [], at: 0 };
  await setSetting(key(agentId), {
    items: stored.items.filter((i) => i.id !== messageId),
    hidden: [...new Set([...stored.hidden, messageId])].slice(-200),
    at: stored.at,
  } satisfies Stored);
}

/** Раздел инструкции агента: образцы стиля. */
export function examplesNote(items: AnswerExample[]): string | undefined {
  if (!items.length) return undefined;
  return [
    "# Удачные ответы — образец стиля",
    "Так ты уже отвечал, и клиентам это понравилось. Держись похожего тона, длины и структуры. Факты (цены, сроки, наличие) бери только из базы знаний и переписки, а не из этих примеров.",
    ...items.map((e, i) => `${i + 1}. Клиент: ${e.question}\n   Ты: ${e.answer}`),
  ].join("\n");
}
