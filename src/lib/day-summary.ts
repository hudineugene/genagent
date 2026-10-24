import "server-only";
import { streamChat } from "@/lib/llm";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";
import { getSetting, setSetting } from "@/lib/settings";
import { getGeneral, studioTz } from "@/lib/general";
import { dashboardData, type Decision } from "@/lib/dashboard";
import { homeFeed } from "@/lib/home-live";

/**
 * Сводка дня от ИИ на «Сегодня»: 3–4 строки — что произошло, кто ждёт, что сделать в первую очередь. Включается
 * в «Общих настройках» (по умолчанию выключена). Собирается из уже посчитанных цифр главной (без переписок),
 * хранится до 6 часов для каждого набора доступных клиентов — около $0,01 в день.
 */
const MODEL = "anthropic:claude-haiku-5-5";
const TTL = 6 * 3_600_000;

type Cached = { day: string; at: number; text: string };

export async function daySummary(ids: string[] | null, locale: string): Promise<string | null> {
  if (!(await getGeneral()).jobs.daySummary) return null;
  const scopeKey = ids ? [...ids].sort().join(",").slice(0, 200) || "none" : "all";
  const key = `day-summary:${locale}:${scopeKey}`;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: studioTz() }).format(new Date());
  const cached = await getSetting<Cached>(key);
  if (cached && cached.day === day && Date.now() - cached.at < TTL) return cached.text;

  return withKeys({}, async () => {
    if (!apiKey("anthropic")) return cached?.text ?? null;
    const [data, feed] = await Promise.all([dashboardData(ids), homeFeed(ids, 40)]);
    const gaps = data.decisions.filter((d): d is Extract<Decision, { kind: "gaps" }> => d.kind === "gaps");
    const kinds = feed.reduce<Record<string, number>>((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {});
    const facts = [
      `За сутки написали ${data.today.wrote} собеседников, агент ответил в ${data.today.answered} разговорах, передано людям ${data.today.handoffs}.`,
      `Расход ИИ за сутки $${data.today.spendDay.toFixed(2)}, за месяц $${data.today.spendMonth.toFixed(2)}.`,
      `Ждут ответа человека: ${data.waiting.length}${data.waiting.length ? ` (дольше всех: ${data.waiting.slice(0, 3).map((w) => `${w.name || w.handle || "посетитель"} — ${w.client}`).join("; ")})` : ""}.`,
      gaps.length ? `Вопросы без ответа: ${gaps.map((g) => `${g.client} — ${g.count}`).join("; ")}.` : "",
      data.decisions.length - gaps.length ? `Ещё требуют решения: ${data.decisions.length - gaps.length}.` : "",
      `События за 3 дня: новых разговоров ${kinds.new ?? 0}, передач менеджеру ${kinds.handoff ?? 0}, горячих клиентов ${kinds.hot ?? 0}, оплат ${kinds.paid ?? 0}.`,
      `Клиенты за неделю: ${data.clients.map((c) => `${c.name}: ${c.conversations} диалогов, ждут ${c.waiting}`).join("; ")}.`,
    ]
      .filter(Boolean)
      .join("\n");
    let text = "";
    const started = Date.now();
    for await (const ev of streamChat({
      model: MODEL,
      effort: "low",
      system: [
        `Ты помощник руководителя студии ИИ-агентов. По цифрам напиши сводку дня: 3–4 короткие строки на ${locale === "uk" ? "украинском" : "русском"}, без заголовков и списков-маркеров.`,
        "1) Главное за сутки одной фразой. 2) Кто ждёт человека и с кого начать. 3) Одно конкретное действие на сегодня (например, ответить на вопросы без ответа у такого-то клиента).",
        "Только факты из данных, без выдумок и без воды. Если всё спокойно — так и скажи одной строкой.",
      ].join("\n"),
      messages: [{ role: "user", content: facts }],
    })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done") await logUsage({ source: "insights", model: ev.servedBy, usage: ev.usage, ms: Date.now() - started }).catch(() => {});
    }
    const out = text.trim();
    if (!out) return cached?.text ?? null;
    await setSetting(key, { day, at: Date.now(), text: out } satisfies Cached);
    return out;
  });
}
