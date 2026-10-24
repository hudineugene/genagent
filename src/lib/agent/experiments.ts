import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentVersions, conversations, messages, settings, usageLog, type Conversation } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { agentConfigSchema, type AgentConfig } from "./types";
import { classify } from "./resolution";

/**
 * A/B и постепенная раскатка версий агента: выбранная версия (B) отвечает в доле новых разговоров, разговор не
 * переключается посередине (вариант запоминается в разговоре). Сравнение A и B — по итогам обращений, передачам
 * менеджеру и стоимости. Эксперимент хранится отдельно от настройки агента (сохранение в конструкторе его не трогает).
 */
export type Experiment = { versionId: string; version: number; share: number; startedAt: number };

const key = (agentId: string) => `experiment:${agentId}`;

export const getExperiment = (agentId: string) => getSetting<Experiment | null>(key(agentId)).then((x) => x ?? null);

export async function startExperiment(agentId: string, versionId: string, share: number) {
  const [v] = await db.select({ id: agentVersions.id, version: agentVersions.version }).from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, agentId)));
  if (!v) throw new Error("not_found");
  const exp: Experiment = { versionId: v.id, version: v.version, share: Math.min(50, Math.max(1, Math.round(share))), startedAt: Date.now() };
  await setSetting(key(agentId), exp);
  return exp;
}

export async function stopExperiment(agentId: string) {
  await db.delete(settings).where(eq(settings.key, key(agentId)));
}

const cache = new Map<string, AgentConfig>();

/**
 * Настройка для ответа: B — если разговор в варианте B; новый разговор попадает в B с вероятностью share%.
 * Разговоры, начатые до эксперимента (агент уже отвечал), остаются на A.
 */
export async function pickVariant(agentId: string, conversation: Pick<Conversation, "id" | "context">, config: AgentConfig, answeredBefore: boolean, rnd = Math.random()) {
  const exp = await getExperiment(agentId);
  let variant = conversation.context?.variant;
  if (!exp) return { config, variant: null };
  if (!variant) {
    variant = answeredBefore ? "A" : rnd * 100 < exp.share ? `B:${exp.versionId}` : "A";
    const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversation.id));
    await db.update(conversations).set({ context: { ...cur?.context, variant } }).where(eq(conversations.id, conversation.id));
  }
  if (variant !== `B:${exp.versionId}`) return { config, variant: "A" };
  let b = cache.get(exp.versionId);
  if (!b) {
    const [v] = await db.select({ config: agentVersions.config }).from(agentVersions).where(eq(agentVersions.id, exp.versionId));
    if (!v) return { config, variant: "A" };
    b = agentConfigSchema.parse(v.config);
    cache.set(exp.versionId, b);
  }
  return { config: b, variant: "B" as const };
}

export type VariantStats = { conversations: number; resolved: number | null; handoffRate: number | null; costPerConversation: number | null };

/** Итоги вариантов с начала эксперимента. */
export async function experimentStats(agentId: string): Promise<{ exp: Experiment | null; A: VariantStats; B: VariantStats }> {
  const exp = await getExperiment(agentId);
  const empty = (): VariantStats => ({ conversations: 0, resolved: null, handoffRate: null, costPerConversation: null });
  if (!exp) return { exp, A: empty(), B: empty() };
  const convs = await db
    .select({ id: conversations.id, variant: sql<string>`json_extract(${conversations.context}, '$.variant')` })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false), gte(conversations.lastMessageAt, new Date(exp.startedAt))));
  const groups = { A: convs.filter((c) => c.variant === "A"), B: convs.filter((c) => c.variant === `B:${exp.versionId}`) };
  const out = { exp, A: empty(), B: empty() };
  for (const k of ["A", "B"] as const) {
    const ids = groups[k].map((c) => c.id);
    if (!ids.length) continue;
    const [msgs, costs] = await Promise.all([
      db.select({ c: messages.conversationId, role: messages.role, text: messages.text, createdAt: messages.createdAt, meta: messages.meta }).from(messages).where(and(inArray(messages.conversationId, ids), eq(messages.status, "sent"))),
      db.select({ cost: sql<number>`coalesce(sum(${usageLog.cost}), 0)` }).from(usageLog).where(inArray(usageLog.conversationId, ids)),
    ]);
    let ok = 0;
    let closed = 0;
    let handoffs = 0;
    for (const id of ids) {
      const list = msgs.filter((m) => m.c === id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const o = classify(list as never, Date.now());
      if (o === "escalated") handoffs++;
      if (o !== "open") closed++;
      if (o === "confirmed" || o === "assumed") ok++;
    }
    out[k] = { conversations: ids.length, resolved: closed ? ok / closed : null, handoffRate: handoffs / ids.length, costPerConversation: Number(costs[0]?.cost ?? 0) / ids.length };
  }
  return out;
}
