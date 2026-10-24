import "server-only";
import { and, asc, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentVersions, conversations, messages, testResults, testRuns, usageLog, users } from "@/db/schema";
import { lastInbound } from "@/lib/channels/health";
import { studioDayStart } from "@/lib/general";
import { agentConfigSchema } from "./types";
import { MODULES, toolModule, type MapStats, type ModuleChange, type MapCoverage, type ReplayStep, type LiveEvent } from "./map-modules";

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
const TREND_DAYS = 30;

/** Начало последних 7 дней. */
export const weekAgo = () => new Date(Date.now() - WEEK_MS);
/** Пометки, которые не сбой: агент остановлен лимитом или выключен */
const NOT_FAILURES = new Set(["budget_exceeded", "client_limit", "agent_not_active"]);

type Meta = NonNullable<(typeof messages.$inferSelect)["meta"]>;

/** Какие модули сработали в ответе агента (по его метаданным). error — модуль ответил ошибкой или нашёл проблему. */
export function modulesOfReply(meta: Meta): { key: string; error: boolean }[] {
  const out: { key: string; error: boolean }[] = [];
  if (meta.procedure) return [{ key: "procedures", error: false }];
  for (const t of meta.tools ?? []) out.push({ key: toolModule(t.name), error: Boolean(t.error) });
  if (meta.kb?.sources?.length) out.push({ key: "kb", error: false });
  if (meta.check && !meta.check.skipped) out.push({ key: "answerCheck", error: !meta.check.ok });
  if (meta.unverified?.length) out.push({ key: "factGuard", error: true });
  if (meta.spoken) out.push({ key: "voiceReplies", error: false });
  if (meta.buttons?.length) out.push({ key: "quickReplies", error: false });
  return out;
}

/**
 * Работа агента для живой карты: за 7 дней — разговоры и сбои по каналам, срабатывания модулей, расходы;
 * за 30 дней — ряды по дням для трендов. Без ИИ.
 */
export async function agentMapStats(agentId: string, channelIds: string[]): Promise<MapStats> {
  const now = new Date();
  const today = studioDayStart(now).getTime();
  const from30 = new Date(today - (TREND_DAYS - 1) * DAY_MS);
  const week = weekAgo();
  const rows = await db
    .select({ role: messages.role, meta: messages.meta, createdAt: messages.createdAt, conversationId: messages.conversationId, channelId: conversations.channelId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false), gte(messages.createdAt, from30)))
    .limit(60_000);
  const [cost] = await db
    .select({ total: sql<number>`coalesce(sum(${usageLog.cost}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.agentId, agentId), gte(usageLog.createdAt, week), inArray(usageLog.source, ["channel"])));
  const last = await lastInbound(channelIds);

  const s: MapStats = {
    replies: 0,
    conversations: 0,
    costUsd: Number(cost?.total ?? 0),
    handoffs: 0,
    voiceIn: 0,
    operatorReplies: 0,
    channels: {},
    modules: {},
    daily: { channels: {}, modules: {}, replies: Array(TREND_DAYS).fill(0) },
  };
  for (const id of channelIds) {
    const at = last.get(id) ?? null;
    s.channels[id] = { conversations: 0, errors: 0, lastInbound: at, stale: !at || now.getTime() - at > WEEK_MS };
    s.daily.channels[id] = Array(TREND_DAYS).fill(0);
  }
  const dayIdx = (d: Date) => TREND_DAYS - 1 - Math.floor((today + DAY_MS - 1 - d.getTime()) / DAY_MS);
  const hit = (key: string, error: boolean, inWeek: boolean, i: number) => {
    (s.daily.modules[key] ??= Array(TREND_DAYS).fill(0))[i]++;
    if (!inWeek) return;
    const m = (s.modules[key] ??= { uses: 0, errors: 0 });
    m.uses++;
    if (error) m.errors++;
  };
  const convs = new Map<string, string | null>();
  const dayConvs = new Set<string>();
  for (const r of rows) {
    const meta = r.meta ?? {};
    const inWeek = r.createdAt >= week;
    const i = Math.max(0, Math.min(TREND_DAYS - 1, dayIdx(r.createdAt)));
    if (r.role === "user") {
      // Ряд канала: разговоры с сообщениями клиента в этот день
      const k = `${r.conversationId}:${i}`;
      if (r.channelId && s.daily.channels[r.channelId] && !dayConvs.has(k)) {
        dayConvs.add(k);
        s.daily.channels[r.channelId][i]++;
      }
      if (!inWeek) continue;
      convs.set(r.conversationId, r.channelId);
      if (meta.kind === "voice") s.voiceIn++;
    } else if (r.role === "operator") {
      if (inWeek) s.operatorReplies++;
    } else if (r.role === "system" && meta.error && !NOT_FAILURES.has(meta.error) && r.channelId && s.channels[r.channelId]) {
      if (inWeek) s.channels[r.channelId].errors++;
    } else if (r.role === "assistant") {
      if (!meta.procedure) {
        s.daily.replies[i]++;
        if (inWeek) {
          s.replies++;
          if (meta.handoff) s.handoffs++;
        }
      }
      for (const m of modulesOfReply(meta)) hit(m.key, m.error, inWeek, i);
    }
  }
  s.conversations = convs.size;
  for (const ch of convs.values()) if (ch && s.channels[ch]) s.channels[ch].conversations++;
  return s;
}

/** История модулей по версиям агента: когда и кто включал или выключал каждый модуль (последние 40 версий). */
export async function moduleHistory(agentId: string): Promise<Record<string, ModuleChange[]>> {
  const rows = await db
    .select({ version: agentVersions.version, config: agentVersions.config, createdAt: agentVersions.createdAt, by: users.name })
    .from(agentVersions)
    .leftJoin(users, eq(users.id, agentVersions.createdBy))
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(agentVersions.version))
    .limit(40);
  const list = rows
    .reverse()
    .map((r) => ({ ...r, cfg: agentConfigSchema.safeParse(r.config) }))
    .filter((r) => r.cfg.success);
  const out: Record<string, ModuleChange[]> = {};
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].cfg.data!;
    const cur = list[i].cfg.data!;
    for (const m of MODULES) {
      const a = m.on(prev);
      const b = m.on(cur);
      if (a !== b) (out[m.key] ??= []).unshift({ version: list[i].version, at: list[i].createdAt.getTime(), by: list[i].by ?? null, on: b });
    }
  }
  return out;
}

/** Покрытие тестами: какие модули сработали хотя бы в одном сценарии последнего завершённого прогона. */
export async function testCoverage(agentId: string): Promise<MapCoverage | null> {
  const [run] = await db
    .select({ id: testRuns.id, version: testRuns.agentVersion, at: testRuns.finishedAt, total: testRuns.total, passed: testRuns.passed })
    .from(testRuns)
    .where(and(eq(testRuns.agentId, agentId), eq(testRuns.status, "done")))
    .orderBy(desc(testRuns.createdAt))
    .limit(1);
  if (!run) return null;
  const results = await db.select({ transcript: testResults.transcript }).from(testResults).where(eq(testResults.runId, run.id));
  const modules = new Set<string>();
  for (const r of results)
    for (const m of r.transcript as { role: string; tools?: string[]; kb?: boolean }[]) {
      if (m.role !== "assistant") continue;
      for (const t of m.tools ?? []) modules.add(toolModule(t));
      if (m.kb) modules.add("kb");
    }
  // Прогоны до записи инструментов в тестах — без данных о модулях
  return { version: run.version, at: run.at?.getTime() ?? null, total: run.total, passed: run.passed, modules: [...modules], recorded: modules.size > 0 };
}

/** Последние разговоры агента для повтора на карте. */
export async function replayList(agentId: string) {
  return db
    .select({ id: conversations.id, contact: conversations.contactName, handle: conversations.contactHandle, channel: conversations.channelType, channelId: conversations.channelId, at: conversations.lastMessageAt, last: conversations.lastMessageText })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(25);
}

/** Разговор по шагам для повтора: реплика клиента → ответ агента и что сработало. */
export async function replaySteps(agentId: string, conversationId: string): Promise<ReplayStep[] | null> {
  const [c] = await db.select({ agentId: conversations.agentId }).from(conversations).where(eq(conversations.id, conversationId));
  if (!c || c.agentId !== agentId) return null;
  const rows = await db
    .select({ role: messages.role, text: messages.text, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(300);
  const steps: ReplayStep[] = [];
  for (const r of rows) {
    const meta = r.meta ?? {};
    if (r.role === "system") {
      if (meta.error && !NOT_FAILURES.has(meta.error)) steps.push({ role: "event", text: meta.error, at: r.createdAt.getTime(), modules: [], error: true });
      else if (r.text === "handoff") steps.push({ role: "event", text: "handoff", at: r.createdAt.getTime(), modules: [] });
      continue;
    }
    steps.push({
      role: r.role === "assistant" ? "agent" : r.role === "user" ? "customer" : r.role === "operator" ? "manager" : "bot",
      text: r.text.slice(0, 2000),
      at: r.createdAt.getTime(),
      modules: r.role === "assistant" ? modulesOfReply(meta) : [],
      sources: meta.kb?.sources?.slice(0, 8),
      tools: meta.tools?.map((t) => t.name),
      check: meta.check && !meta.check.skipped ? { ok: meta.check.ok, problems: meta.check.problems.slice(0, 3), rewritten: Boolean(meta.check.rewritten) } : undefined,
      unverified: meta.unverified?.slice(0, 5),
      cost: meta.cost,
      ms: meta.ms,
      handoff: Boolean(meta.handoff),
    });
  }
  return steps;
}

/** Живой режим: что произошло у агента после момента since (новые сообщения клиентов, сработавшие модули, сбои). */
export async function liveEvents(agentId: string, since: number): Promise<{ events: LiveEvent[]; now: number }> {
  const rows = await db
    .select({ role: messages.role, meta: messages.meta, createdAt: messages.createdAt, channelId: conversations.channelId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false), gt(messages.createdAt, new Date(since))))
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const events: LiveEvent[] = [];
  let now = since;
  for (const r of rows) {
    now = Math.max(now, r.createdAt.getTime());
    const meta = r.meta ?? {};
    if (r.role === "user") events.push({ kind: "in", channelId: r.channelId });
    else if (r.role === "assistant") events.push({ kind: "reply", channelId: r.channelId, modules: modulesOfReply(meta) });
    else if (r.role === "system" && meta.error && !NOT_FAILURES.has(meta.error)) events.push({ kind: "error", channelId: r.channelId });
  }
  return { events, now };
}
