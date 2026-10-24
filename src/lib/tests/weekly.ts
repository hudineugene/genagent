import "server-only";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, testResults, testRuns, testScenarios } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { startRunTracked } from "./engine";
import { studioTz } from "@/lib/general";

/**
 * Еженедельная проверка агентов: в выбранный день и час (по Киеву) прогоняются автотесты всех активных агентов,
 * у которых есть сценарии, и в Telegram приходит отчёт — с пометкой, что сломалось по сравнению с прошлым прогоном.
 */
export type WeeklyTestsSettings = {
  enabled: boolean;
  /** 1 — понедельник … 7 — воскресенье */
  weekday: number;
  /** Час по Киеву, 0–23 */
  hour: number;
  lastRunAt?: number;
  lastSummary?: string;
};

const KEY = "weeklyTests";
export const WEEKLY_DEFAULTS: WeeklyTestsSettings = { enabled: false, weekday: 1, hour: 9 };

export async function getWeeklyTests(): Promise<WeeklyTestsSettings> {
  return { ...WEEKLY_DEFAULTS, ...((await getSetting<WeeklyTestsSettings>(KEY)) ?? {}) };
}

export async function saveWeeklyTests(patch: Partial<WeeklyTestsSettings>) {
  await setSetting(KEY, { ...(await getWeeklyTests()), ...patch });
}

function kyivNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: studioTz(), weekday: "short", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday as string] ?? 1;
  return { weekday, hour: Number(parts.hour) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type AgentReport = {
  agentId: string;
  title: string;
  passed: number;
  total: number;
  score: number | null;
  cost: number;
  error?: string;
  failed: { name: string; summary: string; regression: boolean }[];
};

/** Прогнать автотесты всех активных агентов со сценариями и прислать отчёт. Возвращает число проверенных агентов. */
export async function runWeeklyTests(): Promise<number> {
  const g = globalThis as unknown as { __weeklyRunning?: boolean };
  if (g.__weeklyRunning) return 0;
  g.__weeklyRunning = true;
  try {
    // Воронка за неделю — отдельным сообщением до отчёта проверок.
    try {
      const { agentFunnels, funnelReportHtml } = await import("@/lib/agent/funnel");
      const html = funnelReportHtml(await agentFunnels(Date.now() - 7 * 24 * 60 * 60 * 1000));
      if (html) {
        const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
        const s = await getNotifySettings();
        await notifyTestsReport(html.slice(0, 3900), s?.adminUrl ? `${s.adminUrl}/analytics?days=7` : undefined);
      }
    } catch (e) {
      console.error("weekly funnel report failed", e);
    }
    const withScenarios = await db.selectDistinct({ agentId: testScenarios.agentId }).from(testScenarios);
    if (!withScenarios.length) return 0;
    const list = await db
      .select({ id: agents.id, name: agents.name, client: clients.name })
      .from(agents)
      .innerJoin(clients, eq(clients.id, agents.clientId))
      .where(and(eq(agents.status, "active"), inArray(agents.id, withScenarios.map((a) => a.agentId))));

    const reports: AgentReport[] = [];
    // По одному агенту за раз — внутри прогона и так по 3 сценария параллельно.
    for (const a of list) {
      const title = `${a.client} · ${a.name}`;
      try {
        const [prev] = await db
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(and(eq(testRuns.agentId, a.id), eq(testRuns.status, "done"), isNull(testRuns.model)))
          .orderBy(desc(testRuns.createdAt))
          .limit(1);
        const { runId, done } = await startRunTracked(a.id, null);
        await done;
        const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
        const results = await db.select().from(testResults).where(eq(testResults.runId, runId));
        const prevPassed = new Set(
          prev
            ? (await db.select({ scenarioId: testResults.scenarioId, passed: testResults.passed }).from(testResults).where(eq(testResults.runId, prev.id)))
                .filter((r) => r.passed && r.scenarioId)
                .map((r) => r.scenarioId as string)
            : [],
        );
        reports.push({
          agentId: a.id,
          title,
          passed: run?.passed ?? 0,
          total: run?.total ?? results.length,
          score: run?.score ?? null,
          cost: run?.cost ?? 0,
          error: run?.status === "error" ? (run.error ?? "error") : undefined,
          failed: results
            .filter((r) => !r.passed)
            .map((r) => ({
              name: r.scenarioName,
              summary: r.error ? `ошибка: ${r.error}` : r.summary || r.verdicts.filter((v) => !v.pass).map((v) => v.comment).join("; "),
              regression: Boolean(r.scenarioId && prevPassed.has(r.scenarioId)),
            })),
        });
      } catch (e) {
        reports.push({ agentId: a.id, title, passed: 0, total: 0, score: null, cost: 0, error: e instanceof Error ? e.message : String(e), failed: [] });
      }
    }

    const cost = reports.reduce((s, r) => s + r.cost, 0);
    const allOk = reports.every((r) => !r.error && r.passed === r.total);
    const regressions = reports.reduce((n, r) => n + r.failed.filter((f) => f.regression).length, 0);
    const lines = [
      `🧪 <b>Еженедельная проверка агентов</b>`,
      allOk ? "Все сценарии пройдены." : regressions ? `⚠️ Сломалось с прошлой проверки: ${regressions}` : "Есть непройденные сценарии.",
      "",
    ];
    for (const r of reports) {
      const icon = r.error ? "❌" : r.passed === r.total ? "✅" : "⚠️";
      lines.push(`${icon} <b>${esc(r.title)}</b> — ${r.passed}/${r.total}${r.score != null ? `, оценка ${r.score.toFixed(1)}` : ""}`);
      if (r.error) lines.push(`   ошибка прогона: ${esc(r.error.slice(0, 200))}`);
      for (const f of r.failed.slice(0, 5)) {
        lines.push(`   • ${f.regression ? "🆕 " : ""}«${esc(f.name)}»: ${esc(f.summary.slice(0, 220))}`);
      }
    }
    lines.push("", `Стоимость проверки: $${cost.toFixed(2)}`);
    const summary = `${reports.reduce((s, r) => s + r.passed, 0)}/${reports.reduce((s, r) => s + r.total, 0)} сценариев${regressions ? `, сломалось: ${regressions}` : ""}`;
    await saveWeeklyTests({ lastRunAt: Date.now(), lastSummary: summary });

    const { notifyTestsReport, getNotifySettings } = await import("@/lib/notify/telegram");
    const s = await getNotifySettings();
    const worst = reports.find((r) => r.error || r.passed < r.total) ?? reports[0];
    await notifyTestsReport(lines.join("\n").slice(0, 3900), s?.adminUrl && worst ? `${s.adminUrl}/agents/${worst.agentId}/tests` : undefined);
    return reports.length;
  } finally {
    g.__weeklyRunning = false;
  }
}

/** Раз в час проверяем: включено, нужный день и час по Киеву, и на этой неделе ещё не запускали. */
export function startWeeklyTests() {
  const g = globalThis as unknown as { __weeklyTimer?: ReturnType<typeof setInterval> };
  if (g.__weeklyTimer) return;
  const tick = async () => {
    const s = await getWeeklyTests();
    if (!s.enabled) return;
    const now = kyivNow();
    if (now.weekday !== s.weekday || now.hour !== s.hour) return;
    if (s.lastRunAt && Date.now() - s.lastRunAt < 6 * 24 * 60 * 60 * 1000) return;
    await saveWeeklyTests({ lastRunAt: Date.now() }); // защита от повторного запуска в этот же час
    await runWeeklyTests().catch((e) => console.error("weekly tests failed", e));
  };
  setTimeout(() => void tick(), 3 * 60_000).unref?.();
  g.__weeklyTimer = setInterval(() => void tick(), 20 * 60_000);
  g.__weeklyTimer.unref?.();
}

/** Сценарии, которые есть хоть у одного агента (для подсказки в настройках). */
export async function weeklyCoverage() {
  const rows = await db
    .select({ agentId: testScenarios.agentId })
    .from(testScenarios)
    .innerJoin(agents, eq(agents.id, testScenarios.agentId))
    .where(ne(agents.status, "draft"));
  return { scenarios: rows.length, agents: new Set(rows.map((r) => r.agentId)).size };
}
