import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentConfigSchema } from "@/lib/agent/types";
import { compileSystemPrompt } from "@/lib/agent/compile";
import { RUNTIME_REV } from "@/lib/agent/runtime";
import { agents, clients, testResults, testRuns, testScenarios } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { startRunTracked } from "./engine";

/**
 * Проверка после изменений: когда у агента меняется то, что видит модель (инструкции, общие правила студии после
 * выкладки, сценарии), его автотесты прогоняются сами. Сообщаем в Telegram только о проблемах — что не прошло и что
 * сломалось по сравнению с прошлым прогоном; всё в порядке — тишина. Ждём QUIET_MS после последней правки агента
 * (чтобы не гонять тесты на каждое сохранение) и не больше MAX_PER_DAY прогонов на агента в сутки (расходы).
 */
export type AutoTestsSettings = {
  enabled: boolean;
  /** Отпечаток агента на момент последнего прогона */
  prints?: Record<string, string>;
  /** Прогоны за сутки: агент → [время запуска] */
  runs?: Record<string, number[]>;
};

const KEY = "autoTests";
const QUIET_MS = 10 * 60 * 1000;
const MAX_PER_DAY = 3;
const SERIOUS_SCORE = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getAutoTests(): Promise<AutoTestsSettings> {
  return { enabled: true, ...((await getSetting<AutoTestsSettings>(KEY)) ?? {}) };
}

export async function saveAutoTests(patch: Partial<AutoTestsSettings>) {
  await setSetting(KEY, { ...(await getAutoTests()), ...patch });
}

/** Что видит модель в автотестах агента: собранная инструкция (без базы знаний и даты) и набор сценариев. */
export function fingerprint(prompt: string, scenarioIds: string[]) {
  return createHash("sha256").update(RUNTIME_REV).update("\n--\n").update(prompt).update("\n--\n").update([...scenarioIds].sort().join(",")).digest("hex").slice(0, 16);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Агенты, у которых что-то поменялось с прошлого прогона (и правки уже улеглись). */
export async function changedAgents(now = Date.now()) {
  const s = await getAutoTests();
  const scen = await db.select({ id: testScenarios.id, agentId: testScenarios.agentId }).from(testScenarios);
  const ids = [...new Set(scen.map((x) => x.agentId))];
  if (!ids.length) return [];
  const rows = await db
    .select({ agent: agents, client: clients })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(and(eq(agents.status, "active"), inArray(agents.id, ids)));
  const out: { id: string; title: string; print: string }[] = [];
  for (const { agent, client } of rows) {
    const config = agentConfigSchema.parse(agent.config);
    const prompt = compileSystemPrompt(config, client);
    const print = fingerprint(prompt, scen.filter((x) => x.agentId === agent.id).map((x) => x.id));
    if (s.prints?.[agent.id] === print) continue;
    if (agent.updatedAt && now - agent.updatedAt.getTime() < QUIET_MS) continue;
    if ((s.runs?.[agent.id] ?? []).filter((t) => now - t < DAY_MS).length >= MAX_PER_DAY) continue;
    out.push({ id: agent.id, title: `${client.name} · ${agent.name}`, print });
  }
  return out;
}

/** Прогнать тесты изменившихся агентов; сообщить, если что-то не прошло. Возвращает число прогонов. */
export async function runAutoTests(): Promise<number> {
  const g = globalThis as unknown as { __autoTestsRunning?: boolean; __weeklyRunning?: boolean };
  if (g.__autoTestsRunning || g.__weeklyRunning) return 0;
  g.__autoTestsRunning = true;
  try {
    const s = await getAutoTests();
    if (!s.enabled) return 0;
    const list = await changedAgents();
    if (!list.length) return 0;
    // Агент, которого ещё не проверяли, тоже считается изменившимся: первый прогон — точка отсчёта
    const lines: string[] = [];
    let cost = 0;
    for (const a of list) {
      const now = Date.now();
      const fresh = await getAutoTests();
      await saveAutoTests({
        prints: { ...fresh.prints, [a.id]: a.print },
        runs: { ...fresh.runs, [a.id]: [...(fresh.runs?.[a.id] ?? []).filter((t) => now - t < DAY_MS), now] },
      });
      const [prev] = await db
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(and(eq(testRuns.agentId, a.id), eq(testRuns.status, "done")))
        .orderBy(desc(testRuns.createdAt))
        .limit(1);
      let runId: string;
      try {
        const r = await startRunTracked(a.id, null);
        runId = r.runId;
        await r.done;
      } catch (e) {
        lines.push(`❌ <b>${esc(a.title)}</b> — прогон не запустился: ${esc(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        continue;
      }
      const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
      cost += run?.cost ?? 0;
      const results = await db.select().from(testResults).where(eq(testResults.runId, runId)).orderBy(asc(testResults.scenarioName));
      const prevPassed = new Set(
        prev
          ? (await db.select({ scenarioId: testResults.scenarioId, passed: testResults.passed }).from(testResults).where(eq(testResults.runId, prev.id)))
              .filter((r) => r.passed && r.scenarioId)
              .map((r) => r.scenarioId as string)
          : [],
      );
      // В Telegram — только важное: сломалось с прошлого прогона, серьёзный провал (оценка 6 и ниже) или ошибка.
      // Мелкие замечания судьи видны в отчёте прогона на вкладке «Тесты».
      const failed = results.filter(
        (r) => !r.passed && (r.error || (r.score ?? 0) <= SERIOUS_SCORE || Boolean(r.scenarioId && prevPassed.has(r.scenarioId))),
      );
      if (run?.status !== "error" && !failed.length) continue;
      lines.push(`⚠️ <b>${esc(a.title)}</b> — ${run?.passed ?? 0}/${run?.total ?? results.length}${run?.status === "error" ? `, ошибка: ${esc(run.error ?? "")}` : ""}`);
      for (const f of failed.slice(0, 5)) {
        const why = f.error ? `ошибка: ${f.error}` : f.summary || f.verdicts.filter((v) => !v.pass).map((v) => v.comment).join("; ");
        const isNew = Boolean(f.scenarioId && prevPassed.has(f.scenarioId));
        lines.push(`   • ${isNew ? "🆕 " : ""}«${esc(f.scenarioName)}»: ${esc(why.slice(0, 220))}`);
      }
    }
    if (lines.length) {
      const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
      const ns = await getNotifySettings();
      const text = ["🧪 <b>Проверка после изменений: есть проблемы</b>", "Агент изменился (инструкции, общие правила или сценарии) — автотесты прошли не все. 🆕 — сломалось по сравнению с прошлым прогоном.", "", ...lines, "", `Стоимость проверки: $${cost.toFixed(2)}`].join("\n");
      await notifyTestsReport(text.slice(0, 3900), ns?.adminUrl && list[0] ? `${ns.adminUrl}/agents/${list[0].id}/tests` : undefined);
    }
    return list.length;
  } finally {
    g.__autoTestsRunning = false;
  }
}

export function startAutoTests() {
  const g = globalThis as unknown as { __autoTestsTimer?: ReturnType<typeof setInterval> };
  if (g.__autoTestsTimer) return;
  const tick = () => void runAutoTests().catch((e) => console.error("auto tests failed", e));
  setTimeout(tick, 5 * 60_000).unref?.();
  g.__autoTestsTimer = setInterval(tick, 10 * 60_000);
  g.__autoTestsTimer.unref?.();
}
