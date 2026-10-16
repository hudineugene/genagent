import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations, messages, testScenarios } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { getAutoTests } from "./auto";
import { scenarioFromConversation } from "./engine";

/**
 * Сценарии из реальных разговоров: раз в неделю у каждого агента берём до PER_AGENT разговоров за неделю, где ответ
 * явно не удался — 👎 клиента, недовольный клиент передан человеку, данные не из базы знаний, ответ не отправлен,
 * серьёзное замечание утренней проверки — и превращаем их в автотесты. Новые сценарии сами запускают проверку
 * после изменений (lib/tests/auto.ts). Работает, пока включена «Проверять агента после изменений».
 */
const KEY = "realScenarios";
const PER_AGENT = 3;
const MAX_SCENARIOS = 40;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type State = { lastRunAt?: number; used?: string[] };

/** Насколько разговор показателен: чем больше сигналов, тем раньше берём. */
function signals(rows: { role: string; text: string; status: string; meta: Record<string, unknown> | null }[]) {
  let score = 0;
  const why = new Set<string>();
  const add = (points: number, label: string) => {
    score += points;
    why.add(label);
  };
  for (const m of rows) {
    const meta = (m.meta ?? {}) as { rating?: string; unverified?: string[]; qa?: { severity?: string }; upset?: boolean };
    const agent = m.role === "assistant";
    if (agent && meta.rating === "down") add(3, "👎 клиента");
    if (m.role === "system" && m.text === "handoff" && meta.upset) add(3, "клиент недоволен");
    if (agent && meta.unverified?.length) add(2, "данные не из базы знаний");
    if (agent && m.status === "rejected") add(2, "ответ не отправлен");
    if (agent && meta.qa?.severity === "high") add(2, "замечание проверки качества");
  }
  return { score, why: [...why] };
}

/** Кандидаты агента за неделю: разговоры с сигналами, самые показательные первыми. */
export async function realCandidates(agentId: string, since: number, skip: Set<string>) {
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.isTest, false), eq(conversations.kind, "dm"), gt(conversations.lastMessageAt, new Date(since))));
  const ids = convs.map((c) => c.id).filter((id) => !skip.has(id));
  if (!ids.length) return [];
  const rows = await db
    .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, status: messages.status, meta: messages.meta })
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), gt(messages.createdAt, new Date(since))));
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.conversationId, [...(by.get(r.conversationId) ?? []), r]);
  return [...by.entries()]
    .map(([id, list]) => ({ id, ...signals(list as never) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Разобрать неделю и добавить сценарии. Возвращает список добавленных (для уведомления). */
export async function scenariosFromReal(now = Date.now()): Promise<{ agent: string; name: string; why: string[] }[]> {
  const state = (await getSetting<State>(KEY)) ?? {};
  const used = new Set(state.used ?? []);
  const since = now - WEEK_MS;
  const list = await db
    .select({ id: agents.id, name: agents.name, client: clients.name })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.status, "active"));
  const added: { agent: string; name: string; why: string[] }[] = [];
  for (const a of list) {
    const have = (await db.select({ id: testScenarios.id }).from(testScenarios).where(eq(testScenarios.agentId, a.id))).length;
    if (have >= MAX_SCENARIOS) continue;
    const picks = (await realCandidates(a.id, since, used)).slice(0, Math.min(PER_AGENT, MAX_SCENARIOS - have));
    for (const c of picks) {
      used.add(c.id);
      try {
        const s = await scenarioFromConversation(c.id);
        added.push({ agent: `${a.client} · ${a.name}`, name: s.name, why: c.why });
      } catch (e) {
        console.error("scenario from real conversation failed", c.id, e);
      }
    }
  }
  await setSetting(KEY, { lastRunAt: now, used: [...used].slice(-500) });
  return added;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function startRealScenarios() {
  const g = globalThis as unknown as { __realScenTimer?: ReturnType<typeof setInterval> };
  if (g.__realScenTimer) return;
  const tick = async () => {
    if (!(await getAutoTests()).enabled) return;
    const state = (await getSetting<State>(KEY)) ?? {};
    if (state.lastRunAt && Date.now() - state.lastRunAt < WEEK_MS - 60 * 60_000) return;
    const added = await scenariosFromReal();
    if (!added.length) return;
    const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
    const s = await getNotifySettings();
    const lines = [
      `🧪 <b>Новые автотесты из реальных разговоров: ${added.length}</b>`,
      "Разговоры за неделю, где ответ не удался, превращены в сценарии — проверка запустится сама. Критерии черновые: при желании поправьте на вкладке «Проверка».",
      "",
      ...added.map((x) => `• ${esc(x.agent)}: «${esc(x.name)}» — ${esc(x.why.join(", "))}`),
    ];
    await notifyTestsReport(lines.join("\n").slice(0, 3900), s?.adminUrl);
  };
  setTimeout(() => void tick().catch((e) => console.error("real scenarios failed", e)), 15 * 60_000).unref?.();
  g.__realScenTimer = setInterval(() => void tick().catch((e) => console.error("real scenarios failed", e)), 6 * 60 * 60_000);
  g.__realScenTimer.unref?.();
}
