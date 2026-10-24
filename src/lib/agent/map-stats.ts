import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, usageLog } from "@/db/schema";
import { lastInbound } from "@/lib/channels/health";
import { toolModule, type MapStats } from "./map-modules";

const WEEK_MS = 7 * 24 * 3600_000;

/** Начало последних 7 дней. */
export const weekAgo = () => new Date(Date.now() - WEEK_MS);
/** Пометки, которые не сбой: агент остановлен лимитом или выключен */
const NOT_FAILURES = new Set(["budget_exceeded", "client_limit", "agent_not_active"]);

/** Работа агента за 7 дней для живой карты: разговоры и сбои по каналам, срабатывания модулей, расходы. Без ИИ. */
export async function agentMapStats(agentId: string, channelIds: string[]): Promise<MapStats> {
  const since = weekAgo();
  const rows = await db
    .select({ role: messages.role, meta: messages.meta, conversationId: messages.conversationId, channelId: conversations.channelId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false), gte(messages.createdAt, since)))
    .limit(20_000);
  const [cost] = await db
    .select({ total: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.agentId, agentId), gte(usageLog.createdAt, since), inArray(usageLog.source, ["channel"])));
  const last = await lastInbound(channelIds);

  const s: MapStats = { replies: 0, conversations: 0, costUsd: Number(cost?.total ?? 0), handoffs: 0, voiceIn: 0, operatorReplies: 0, channels: {}, modules: {} };
  const now = Date.now();
  for (const id of channelIds) {
    const at = last.get(id) ?? null;
    s.channels[id] = { conversations: 0, errors: 0, lastInbound: at, stale: !at || now - at > WEEK_MS };
  }
  const hit = (key: string, error = false) => {
    const m = (s.modules[key] ??= { uses: 0, errors: 0 });
    m.uses++;
    if (error) m.errors++;
  };
  const convs = new Map<string, string | null>();
  for (const r of rows) {
    const meta = r.meta ?? {};
    if (r.role === "user") {
      convs.set(r.conversationId, r.channelId);
      if (meta.kind === "voice") s.voiceIn++;
    } else if (r.role === "operator") {
      s.operatorReplies++;
    } else if (r.role === "system" && meta.error && !NOT_FAILURES.has(meta.error) && r.channelId && s.channels[r.channelId]) {
      s.channels[r.channelId].errors++;
    } else if (r.role === "assistant") {
      if (meta.procedure) {
        hit("procedures");
        continue;
      }
      s.replies++;
      if (meta.handoff) s.handoffs++;
      for (const t of meta.tools ?? []) hit(toolModule(t.name), Boolean(t.error));
      if (meta.kb?.sources?.length) hit("kb");
      if (meta.check && !meta.check.skipped) hit("answerCheck", !meta.check.ok);
      if (meta.unverified?.length) hit("factGuard", true);
      if (meta.spoken) hit("voiceReplies");
      if (meta.buttons?.length) hit("quickReplies");
    }
  }
  s.conversations = convs.size;
  for (const ch of convs.values()) if (ch && s.channels[ch]) s.channels[ch].conversations++;
  return s;
}
