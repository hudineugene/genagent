import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations, messages, routines, type Routine, type RoutineSchedule, type RoutineSource } from "@/db/schema";
import { streamChat } from "@/lib/llm";
import { logUsage } from "@/lib/usage";

/**
 * Отчёты по расписанию. Раз в 10 минут проверяем, кому пора (время — по Киеву); отчёт: данные из источников →
 * дешёвая модель выполняет задание владельца → текст в Telegram сотрудникам студии и/или владельцу бизнеса.
 * Поиск в интернете — только если он разрешён в «Внешних сервисах».
 */
const MODEL = "anthropic:claude-haiku-5-5";
const SOURCE_CHARS = 40_000;
const TOTAL_CHARS = 120_000;

const TZ = "Europe/Kyiv";
function kyiv(at: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${p.year}-${p.month}-${p.day}`, day: Number(p.day), month: Number(p.month), year: Number(p.year), weekday: WD[p.weekday], hour: Number(p.hour) };
}

/** Пора ли запускать: наступил час по расписанию, подходящий день, и сегодня ещё не запускали. */
export function isDue(s: RoutineSchedule, lastRunAt: Date | null, now = new Date()) {
  const k = kyiv(now);
  if (k.hour < s.hour) return false;
  if (lastRunAt && kyiv(lastRunAt).date === k.date) return false;
  if (s.freq === "weekly") return k.weekday === (s.weekday ?? 1);
  if (s.freq === "monthly") {
    const days = new Date(k.year, k.month, 0).getDate();
    return k.day === Math.min(s.day ?? 1, days);
  }
  return true;
}

async function conversationsText(clientId: string, days: number, agentIds?: string[]) {
  const since = new Date(Date.now() - days * 86400_000);
  const convs = await db
    .select({ id: conversations.id, name: conversations.contactName, agent: agents.name })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(and(eq(conversations.clientId, clientId), eq(conversations.isTest, false), ...(agentIds?.length ? [inArray(conversations.agentId, agentIds)] : [])));
  if (!convs.length) return "Разговоров за период нет.";
  const rows = await db
    .select({ cid: messages.conversationId, role: messages.role, text: messages.text, meta: messages.meta })
    .from(messages)
    .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), gt(messages.createdAt, since)))
    .orderBy(asc(messages.createdAt));
  const by = new Map<string, string[]>();
  let ratingsUp = 0;
  let ratingsDown = 0;
  let handoffs = 0;
  for (const m of rows) {
    const l = by.get(m.cid) ?? [];
    by.set(m.cid, l);
    if (m.role === "user") l.push(`К: ${m.text.slice(0, 300)}`);
    else if (m.role === "assistant") l.push(`А: ${m.text.slice(0, 300)}`);
    else if (m.role === "operator") l.push(`С: ${m.text.slice(0, 300)}`);
    else if (m.role === "system" && m.text === "handoff") {
      handoffs++;
      l.push("[передан менеджеру]");
    }
    if (m.meta?.rating === "up") ratingsUp++;
    if (m.meta?.rating === "down") ratingsDown++;
  }
  const active = convs.filter((c) => by.get(c.id)?.some((l) => l.startsWith("К:")));
  const head = `За ${days} дн.: разговоров ${active.length}, передано менеджеру ${handoffs}, оценки 👍 ${ratingsUp} / 👎 ${ratingsDown}.`;
  const body = active.map((c) => `— ${c.name || "клиент"} (${c.agent}):\n${(by.get(c.id) ?? []).join("\n")}`).join("\n\n");
  return `${head}\n\n${body}`;
}

/** Данные одного источника — текстом для модели. Ошибка источника не валит отчёт. */
async function sourceText(clientId: string, src: RoutineSource): Promise<string> {
  try {
    if (src.type === "conversations") return `## Разговоры с клиентами\n${(await conversationsText(clientId, src.days, src.agentIds)).slice(0, SOURCE_CHARS)}`;
    if (src.type === "sheet") {
      const { readValues, spreadsheetId } = await import("@/lib/google/sheets");
      const id = spreadsheetId(src.url);
      if (!id) return `## Таблица\n(неверная ссылка)`;
      const rows = await readValues(id, src.sheet || "Лист1");
      return `## Таблица «${src.sheet}»\n${rows.map((r) => r.join(" | ")).join("\n").slice(0, SOURCE_CHARS)}`;
    }
    if (src.type === "url") {
      const { assertPublicHost } = await import("@/lib/agent/custom-tools");
      await assertPublicHost(new URL(src.url).hostname);
      const { crawl } = await import("@/lib/kb/crawl");
      const [page] = await crawl(src.url, "page");
      return `## Страница ${src.url}${page ? ` — ${page.title}` : ""}\n${(page?.text ?? "(пусто)").slice(0, SOURCE_CHARS)}`;
    }
    return `## Поиск в интернете\nНайди в интернете: ${src.query}`;
  } catch (e) {
    return `## Источник недоступен (${src.type}): ${e instanceof Error ? e.message : String(e)}`;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Текст модели → HTML Telegram: экранируем, **жирный** → <b>, заголовки «#» → жирные строки. */
export function toTelegramHtml(text: string) {
  return esc(text)
    .replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

/** Выполнить отчёт сейчас: собрать данные, получить текст, отправить. Возвращает текст отчёта. */
export async function runRoutine(id: string, opts: { send?: boolean } = {}): Promise<{ ok: boolean; text: string }> {
  const [r] = await db.select().from(routines).where(eq(routines.id, id));
  if (!r) return { ok: false, text: "not_found" };
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, r.clientId));
  const finish = async (status: string, text: string) => {
    await db.update(routines).set({ lastRunAt: new Date(), lastStatus: status.slice(0, 120), lastResult: text.slice(0, 20_000) }).where(eq(routines.id, r.id));
  };
  try {
    let data = "";
    for (const s of r.sources) {
      if (data.length > TOTAL_CHARS) break;
      data += `\n\n${await sourceText(r.clientId, s)}`;
    }
    const search = r.sources.some((s) => s.type === "search");
    const { getServices } = await import("@/lib/services");
    const services = await getServices();
    const webSearch = search && services.webSearch.enabled ? { maxUses: Math.max(services.webSearch.maxUses, 3) } : undefined;
    const today = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, dateStyle: "long" }).format(new Date());
    let text = "";
    const started = Date.now();
    for await (const ev of streamChat({
      model: MODEL,
      effort: "low",
      system: [
        `Ты аналитик компании «${client?.name ?? ""}». Сегодня ${today}. Выполни задание владельца по данным ниже и напиши готовый отчёт для Telegram.`,
        "Пиши по-русски, коротко и по делу: сначала главный вывод 1–2 предложениями, затем 3–8 пунктов с цифрами и конкретикой, в конце — что сделать. Без вступлений и воды.",
        "Опирайся только на данные ниже (и на поиск в интернете, если он есть). Чего нет в данных — так и скажи, не выдумывай цифры.",
        search && !webSearch ? "Поиск в интернете сейчас выключен в настройках — отметь, что эту часть задания выполнить не удалось." : "",
      ]
        .filter(Boolean)
        .join("\n"),
      messages: [{ role: "user", content: `Задание: ${r.task}\n\nДанные:${data || "\n(источники не заданы)"}` }],
      webSearch,
    })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done") await logUsage({ source: "insights", model: ev.servedBy, usage: ev.usage, clientId: r.clientId, ms: Date.now() - started }).catch(() => {});
    }
    text = text.trim();
    if (!text) throw new Error("empty_report");
    if (opts.send !== false) {
      const html = `📊 <b>${esc(r.name)}</b>\n${esc(client?.name ?? "")}\n\n${toTelegramHtml(text)}`.slice(0, 3900);
      const tg = await import("@/lib/notify/telegram");
      if (r.delivery.team) await tg.sendToTeam(html);
      if (r.delivery.owners) await tg.sendToOwners(r.clientId, html);
    }
    await finish("ok", text);
    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("routine failed", r.id, msg);
    await finish(`error: ${msg}`, "");
    return { ok: false, text: msg };
  }
}

/** Запустить те, кому пора. */
export async function runDueRoutines(now = new Date()) {
  const list = await db.select().from(routines).where(eq(routines.enabled, true));
  let n = 0;
  for (const r of list) {
    if (!isDue(r.schedule, r.lastRunAt, now)) continue;
    await runRoutine(r.id);
    n++;
  }
  return n;
}

export function startRoutines() {
  const g = globalThis as unknown as { __routinesTimer?: ReturnType<typeof setInterval>; __routinesBusy?: boolean };
  if (g.__routinesTimer) return;
  g.__routinesTimer = setInterval(() => {
    if (g.__routinesBusy) return;
    g.__routinesBusy = true;
    void runDueRoutines()
      .catch((e) => console.error("routines tick failed", e))
      .finally(() => (g.__routinesBusy = false));
  }, 10 * 60_000);
  g.__routinesTimer.unref?.();
}

export type { Routine };
