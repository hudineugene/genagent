import "server-only";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, agents, clients, conversations, messages, usageLog } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { agentReviewHistory } from "./review";
import type { AgentConfig } from "./types";

/**
 * Отчёт владельцу бизнеса за месяц — польза агента в цифрах: сколько людей написали, скольким ответил агент
 * без участия сотрудников, результаты (заявки, брифы, просмотры, оплаты), сэкономленное время, о чём спрашивали
 * и чего не хватило (из еженедельных разборов). Готовая HTML-страница: открыть, распечатать в PDF, переслать.
 * Без ИИ — только подсчёт по базе. Стоимость ИИ в отчёт не попадает (это внутреннее дело студии).
 */
const MINUTES_PER_ANSWER = 2; // сколько времени сотрудника заняло бы набрать один ответ (оценка, указана в отчёте)
const NOT_RESULT = new Set(["followup_sent", "brief_started", "brief_prefilled", "rating_up", "rating_down"]);
const CHANNEL_LABELS: Record<string, { ru: string; uk: string }> = {
  api: { ru: "Telegram-бот", uk: "Telegram-бот" },
  telegram: { ru: "Telegram", uk: "Telegram" },
  widget: { ru: "Чат на сайте", uk: "Чат на сайті" },
  instagram: { ru: "Instagram", uk: "Instagram" },
  threads: { ru: "Threads", uk: "Threads" },
  email: { ru: "Почта", uk: "Пошта" },
};

export type ClientReport = {
  client: string;
  lang: "ru" | "uk";
  from: number;
  to: number;
  people: number;
  answers: number;
  selfServed: number;
  handedOff: number;
  upset: number;
  hoursSaved: number;
  avgReplySec: number | null;
  ratingUp: number;
  ratingDown: number;
  results: { label: string; people: number; value: number }[];
  byChannel: { label: string; people: number }[];
  byDay: { day: string; people: number }[];
  topics: string[];
  unmet: { demand: string; detail: string }[];
  ideas: string[];
};

/** Смещение времени Киева от UTC в момент t (зима +2 ч, лето +3 ч). */
function kyivOffsetMs(t: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
}

/** Полночь 1-го числа по Киеву: начало месяца (YYYY-MM) и начало следующего, в мс. */
export function monthRange(month: string): { from: number; to: number } {
  const [y, m] = month.split("-").map(Number);
  const midnight = (yy: number, mm: number) => {
    const u = Date.UTC(yy, mm - 1, 1);
    return u - kyivOffsetMs(u);
  };
  return { from: midnight(y, m), to: m === 12 ? midnight(y + 1, 1) : midnight(y, m + 1) };
}

export function previousMonth(now = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const m = Number(p.month);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export async function clientReport(clientId: string, month: string): Promise<ClientReport | null> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return null;
  const { from, to } = monthRange(month);
  const agentRows = await db.select().from(agents).where(eq(agents.clientId, clientId));
  const lang: "ru" | "uk" = agentRows.some((a) => (a.config as AgentConfig).replyLanguage === "uk") ? "uk" : "ru";
  const convs = await db
    .select({ id: conversations.id, externalId: conversations.externalId, channelId: conversations.channelId, channelType: conversations.channelType })
    .from(conversations)
    // тестовые разговоры — не в счёт
    .where(and(eq(conversations.clientId, clientId), eq(conversations.isTest, false)));
  const convById = new Map(convs.map((c) => [c.id, c]));
  const rows = convs.length
    ? await db
        .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, status: messages.status, meta: messages.meta, createdAt: messages.createdAt })
        .from(messages)
        .where(and(inArray(messages.conversationId, convs.map((c) => c.id)), gt(messages.createdAt, new Date(from)), lt(messages.createdAt, new Date(to))))
    : [];

  const person = (convId: string) => {
    const c = convById.get(convId);
    return c ? `${c.channelId}:${c.externalId}` : convId;
  };
  const wrote = new Set<string>();
  const answered = new Set<string>();
  const human = new Set<string>();
  const upsetSet = new Set<string>();
  const byChannel = new Map<string, Set<string>>();
  const byDay = new Map<string, Set<string>>();
  let answers = 0;
  const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(d);
  for (const m of rows) {
    if (m.meta?.fromSite) continue; // перенесено с сайта — уже посчитано там
    const who = person(m.conversationId);
    if (m.role === "user") {
      wrote.add(who);
      const type = convById.get(m.conversationId)?.channelType ?? "api";
      byChannel.set(type, (byChannel.get(type) ?? new Set()).add(who));
      const day = dayKey(m.createdAt);
      byDay.set(day, (byDay.get(day) ?? new Set()).add(who));
    } else if (m.role === "assistant" && m.status === "sent") {
      answers++;
      answered.add(who);
    } else if (m.role === "operator" || (m.role === "system" && m.text === "handoff")) {
      human.add(who);
      if (m.meta?.upset) upsetSet.add(who);
    }
  }

  const events = agentRows.length
    ? await db
        .select()
        .from(agentEvents)
        .where(
          and(
            inArray(agentEvents.agentId, agentRows.map((a) => a.id)),
            gt(agentEvents.createdAt, new Date(from)),
            lt(agentEvents.createdAt, new Date(to)),
            sql`(${agentEvents.conversationId} is null or ${agentEvents.conversationId} not in (select id from conversations where is_test = 1))`,
          ),
        )
    : [];
  const results = new Map<string, { label: string; people: Set<string>; value: number }>();
  let ratingUp = 0;
  let ratingDown = 0;
  for (const e of events) {
    if (e.type === "rating_up") ratingUp++;
    if (e.type === "rating_down") ratingDown++;
    if (NOT_RESULT.has(e.type)) continue;
    const r = results.get(e.type) ?? { label: e.label || e.type, people: new Set<string>(), value: 0 };
    r.people.add(`${e.channelId}:${e.externalUserId}`);
    r.value += e.value ?? 0;
    results.set(e.type, r);
  }

  const usage = agentRows.length
    ? await db
        .select({ ms: usageLog.ms })
        .from(usageLog)
        .where(and(inArray(usageLog.agentId, agentRows.map((a) => a.id)), eq(usageLog.source, "channel"), gt(usageLog.createdAt, new Date(from)), lt(usageLog.createdAt, new Date(to))))
    : [];
  const ms = usage.map((u) => u.ms ?? 0).filter((x) => x > 0);

  // Выводы еженедельных разборов этого месяца
  const reviews = (await Promise.all(agentRows.map((a) => agentReviewHistory(a.id)))).flat().filter((r) => r.at >= from && r.at < to + 3 * 24 * 3_600_000);
  const topics = [...new Set(reviews.flatMap((r) => r.topics.map((t) => t.topic)))].slice(0, 10);
  const unmetSeen = new Set<string>();
  const unmet = reviews
    .flatMap((r) => r.unmet)
    .filter((u) => {
      const k = u.demand.toLowerCase();
      if (unmetSeen.has(k)) return false;
      unmetSeen.add(k);
      return true;
    })
    .slice(0, 8)
    .map((u) => ({ demand: u.demand, detail: u.detail }));
  const ideas = [...new Set(reviews.flatMap((r) => r.ideas))].slice(0, 5);

  const days: { day: string; people: number }[] = [];
  for (let t = from; t < to; t += 24 * 3_600_000) {
    const day = dayKey(new Date(t + 12 * 3_600_000));
    if (!days.some((d) => d.day === day)) days.push({ day, people: byDay.get(day)?.size ?? 0 });
  }

  return {
    client: client.name,
    lang,
    from,
    to,
    people: wrote.size,
    answers,
    selfServed: [...answered].filter((p) => !human.has(p)).length,
    handedOff: human.size,
    upset: upsetSet.size,
    hoursSaved: Math.round(((answers * MINUTES_PER_ANSWER) / 60) * 10) / 10,
    avgReplySec: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 100) / 10 : null,
    ratingUp,
    ratingDown,
    results: [...results.values()].map((r) => ({ label: r.label, people: r.people.size, value: r.value })).sort((a, b) => b.people - a.people),
    byChannel: [...byChannel.entries()].map(([type, set]) => ({ label: CHANNEL_LABELS[type]?.[lang] ?? type, people: set.size })).sort((a, b) => b.people - a.people),
    byDay: days,
    topics,
    unmet,
    ideas,
  };
}

const T = {
  ru: {
    title: "Отчёт ИИ-агента",
    people: "людей написали",
    answers: "ответов агента",
    selfServed: "получили ответ без сотрудника",
    handedOff: "переданы сотрудникам",
    upset: "из них недовольны",
    saved: "часов работы сэкономлено",
    savedNote: `оценка: ${MINUTES_PER_ANSWER} мин. сотрудника на один ответ`,
    speed: "среднее время ответа агента",
    sec: "с",
    results: "Результаты после разговора с агентом",
    resultsNone: "Событий-результатов от бота за месяц нет.",
    peopleShort: "чел.",
    byDay: "Сколько людей писали по дням",
    byChannel: "Каналы",
    ratings: "Оценки ответов",
    topics: "О чём спрашивали",
    unmet: "Чего клиентам не хватило",
    ideas: "Идеи",
    footer: "Подготовлено GenAgent · студия YABOT",
    months: ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"],
  },
  uk: {
    title: "Звіт ШІ-агента",
    people: "людей написали",
    answers: "відповідей агента",
    selfServed: "отримали відповідь без співробітника",
    handedOff: "передано співробітникам",
    upset: "з них незадоволені",
    saved: "годин роботи заощаджено",
    savedNote: `оцінка: ${MINUTES_PER_ANSWER} хв співробітника на одну відповідь`,
    speed: "середній час відповіді агента",
    sec: "с",
    results: "Результати після розмови з агентом",
    resultsNone: "Подій-результатів від бота за місяць немає.",
    peopleShort: "ос.",
    byDay: "Скільки людей писали по днях",
    byChannel: "Канали",
    ratings: "Оцінки відповідей",
    topics: "Про що питали",
    unmet: "Чого клієнтам забракло",
    ideas: "Ідеї",
    footer: "Підготовлено GenAgent · студія YABOT",
    months: ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"],
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ");

export function reportMonthTitle(r: ClientReport) {
  const d = new Date(r.from + 12 * 3_600_000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${T[r.lang].months[Number(p.month) - 1]} ${p.year}`;
}

/** Готовая HTML-страница отчёта (без внешних файлов; печатается в PDF из браузера). */
export function clientReportHtml(r: ClientReport): string {
  const t = T[r.lang];
  const max = Math.max(1, ...r.byDay.map((d) => d.people));
  const W = 720;
  const H = 120;
  const bw = W / Math.max(1, r.byDay.length);
  const bars = r.byDay
    .map((d, i) => {
      const h = Math.round((d.people / max) * (H - 18));
      return `<rect x="${(i * bw + 1).toFixed(1)}" y="${H - 14 - h}" width="${Math.max(2, bw - 3).toFixed(1)}" height="${h}" rx="3" fill="#5b5bf0"><title>${d.day}: ${d.people}</title></rect>` +
        (i % 5 === 0 ? `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 2}" font-size="10" text-anchor="middle" fill="#8a90a2">${Number(d.day.slice(8))}</text>` : "");
    })
    .join("");
  const kpi = (value: string, label: string, note = "") =>
    `<div class="kpi"><div class="v">${value}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ""}</div>`;
  const pct = r.people ? Math.round((r.selfServed / r.people) * 100) : 0;
  return `<!doctype html>
<html lang="${r.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)} — ${esc(r.client)} — ${esc(reportMonthTitle(r))}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f9;color:#141824;font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
.page{max-width:820px;margin:24px auto;background:#fff;border-radius:20px;padding:36px 40px;box-shadow:0 2px 16px rgba(20,24,36,.06)}
h1{margin:0;font-size:26px}h2{font-size:17px;margin:28px 0 10px}.sub{color:#667085;margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:24px}
.kpi{background:#f6f7fb;border-radius:14px;padding:14px 16px}.kpi .v{font-size:28px;font-weight:700;color:#3f3fd0}.kpi .l{color:#3b4152}.kpi .n{color:#8a90a2;font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #eceef4}td.r{text-align:right;white-space:nowrap;color:#3b4152}
ul{margin:0;padding-left:20px}li{margin:4px 0}.muted{color:#8a90a2}.chips span{display:inline-block;background:#f0f0fe;color:#3f3fd0;border-radius:999px;padding:3px 10px;margin:0 6px 6px 0;font-size:13px}
.foot{margin-top:32px;color:#8a90a2;font-size:12px;text-align:center}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;border-radius:0}}
@media (max-width:600px){.page{padding:22px 18px;margin:0;border-radius:0}}
</style></head><body><div class="page">
<h1>${esc(t.title)}</h1>
<div class="sub">${esc(r.client)} · ${esc(reportMonthTitle(r))}</div>
<div class="kpis">
${kpi(num(r.people), t.people)}
${kpi(`${pct}%`, t.selfServed, `${num(r.selfServed)} ${t.peopleShort}`)}
${kpi(num(r.answers), t.answers)}
${kpi(String(r.hoursSaved).replace(".", ","), t.saved, t.savedNote)}
${kpi(num(r.handedOff), t.handedOff, r.upset ? `${t.upset}: ${r.upset}` : "")}
${r.avgReplySec != null ? kpi(`${String(r.avgReplySec).replace(".", ",")} ${t.sec}`, t.speed) : ""}
</div>
<h2>${esc(t.results)}</h2>
${r.results.length ? `<table>${r.results.map((x) => `<tr><td>${esc(x.label)}</td><td class="r">${num(x.people)} ${t.peopleShort}${x.value ? ` · ${num(x.value)}` : ""}</td></tr>`).join("")}</table>` : `<p class="muted">${esc(t.resultsNone)}</p>`}
<h2>${esc(t.byDay)}</h2>
<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${bars}</svg>
${r.byChannel.length ? `<h2>${esc(t.byChannel)}</h2><table>${r.byChannel.map((c) => `<tr><td>${esc(c.label)}</td><td class="r">${num(c.people)} ${t.peopleShort}</td></tr>`).join("")}</table>` : ""}
${r.ratingUp || r.ratingDown ? `<h2>${esc(t.ratings)}</h2><p>👍 ${r.ratingUp} · 👎 ${r.ratingDown}</p>` : ""}
${r.topics.length ? `<h2>${esc(t.topics)}</h2><div class="chips">${r.topics.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
${r.unmet.length ? `<h2>${esc(t.unmet)}</h2><ul>${r.unmet.map((u) => `<li><b>${esc(u.demand)}</b>${u.detail ? ` — ${esc(u.detail)}` : ""}</li>`).join("")}</ul>` : ""}
${r.ideas.length ? `<h2>${esc(t.ideas)}</h2><ul>${r.ideas.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
<div class="foot">${esc(t.footer)}</div>
</div></body></html>`;
}

/** Имя файла отчёта: report-<клиент>-YYYY-MM.html (латиница). */
export function reportFileName(r: ClientReport, month: string) {
  const slug = r.client.toLowerCase().replace(/[^a-z0-9а-яіїєґё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "client";
  return `report-${slug}-${month}.html`;
}

/** Разослать отчёты за прошлый месяц подписчикам бота уведомлений (файлом — переслать владельцу). */
export async function sendMonthlyReports(month = previousMonth()): Promise<number> {
  const { getNotifySettings } = await import("@/lib/notify/telegram");
  const notify = await getNotifySettings();
  if (!notify?.token || !notify.subscribers.length) return 0;
  const api = process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";
  let sent = 0;
  for (const c of await db.select({ id: clients.id }).from(clients)) {
    const r = await clientReport(c.id, month);
    if (!r || !r.people) continue;
    const html = clientReportHtml(r);
    const t = T[r.lang];
    const caption = `📊 <b>${esc(t.title)}</b> — ${esc(r.client)}, ${esc(reportMonthTitle(r))}\n${num(r.people)} ${t.people} · ${r.people ? Math.round((r.selfServed / r.people) * 100) : 0}% ${t.selfServed}\n<i>Откройте файл в браузере и перешлите владельцу (можно распечатать в PDF).</i>`;
    for (const sub of notify.subscribers) {
      const form = new FormData();
      form.set("chat_id", sub.chatId);
      form.set("caption", caption);
      form.set("parse_mode", "HTML");
      form.set("document", new Blob([html], { type: "text/html" }), reportFileName(r, month));
      await fetch(`${api}/bot${notify.token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) }).catch((e) =>
        console.error("monthly report send failed", sub.chatId, e instanceof Error ? e.message : e),
      );
    }
    sent++;
  }
  return sent;
}

/** 1-го числа после 10:00 по Киеву — отчёты за прошлый месяц (один раз в месяц). */
export function startMonthlyReports() {
  const g = globalThis as unknown as { __reportTimer?: ReturnType<typeof setInterval> };
  if (g.__reportTimer) return;
  const tick = async () => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]),
    );
    if (Number(p.day) !== 1 || Number(p.hour) < 10) return;
    const month = previousMonth();
    if ((await getSetting<string>("monthlyReportsSent")) === month) return;
    await setSetting("monthlyReportsSent", month);
    await sendMonthlyReports(month).catch((e) => console.error("monthly reports failed", e));
  };
  setTimeout(() => void tick(), 7 * 60_000).unref?.();
  g.__reportTimer = setInterval(() => void tick(), 30 * 60_000);
  g.__reportTimer.unref?.();
}
