import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, usageLog } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { CHANNEL_BRAND, CHANNEL_LABEL, GROUPS, MODULES } from "@/lib/agent/map-modules";
import { agentMapStats, moduleHistory } from "@/lib/agent/map-stats";
import { getGeneral, studioTz } from "@/lib/general";
import { MODELS } from "@/lib/models";
import { PrintButton } from "@/app/d/[docId]/print-button";

const sum = (a?: number[]) => (a ?? []).reduce((x, y) => x + y, 0);

/**
 * Отчёт-страница агента на одну страницу A4 (печать → «Сохранить как PDF»): схема, итоги 30 дней, каналы, модули,
 * изменения за месяц. owner — для кабинета владельца: без себестоимости студии, с брендом студии.
 */
export async function AgentReport({ agentId, owner, brand, locale }: { agentId: string; owner?: boolean; brand?: { name: string; color: string }; locale: "ru" | "uk" }) {
  const uk = locale === "uk";
  const [row] = await db.select({ agent: agents, client: clients.name }).from(agents).innerJoin(clients, eq(clients.id, agents.clientId)).where(eq(agents.id, agentId));
  if (!row) return null;
  const parsed = agentConfigSchema.safeParse(row.agent.config);
  if (!parsed.success) return null;
  const config = parsed.data;
  const chs = await db.select({ id: channels.id, type: channels.type, name: channels.name, enabled: channels.enabled }).from(channels).where(eq(channels.agentId, agentId));
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [stats, history, general, [cost]] = await Promise.all([
    agentMapStats(agentId, chs.map((c) => c.id)),
    moduleHistory(agentId),
    getGeneral(),
    db.select({ total: sql<number>`coalesce(sum(${usageLog.cost}), 0)` }).from(usageLog).where(and(eq(usageLog.agentId, agentId), gte(usageLog.createdAt, monthStart))),
  ]);
  const color = brand?.color ?? "#4f46e5";
  const studio = brand?.name ?? general.studioName;
  const fmt = new Intl.DateTimeFormat(uk ? "uk-UA" : "ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: studioTz() });
  const short = new Intl.DateTimeFormat(uk ? "uk-UA" : "ru-RU", { day: "2-digit", month: "2-digit", timeZone: studioTz() });
  const conv30 = sum(Object.values(stats.daily.channels).flat());
  const replies30 = sum(stats.daily.replies);
  const changes = Object.entries(history)
    .flatMap(([key, list]) => list.filter((h) => h.at >= monthStart.getTime()).map((h) => ({ key, ...h })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);
  const title = (k: string) => MODULES.find((m) => m.key === k)?.title[locale] ?? k;
  const model = MODELS.find((m) => m.id === config.model)?.label ?? config.model;
  const L = (ru: string, ukText: string) => (uk ? ukText : ru);

  return (
    <div className="mx-auto max-w-[820px] bg-white p-8 text-[13px] text-[#111827] print:p-0">
      <style>{`@page { size: A4; margin: 14mm } body { background: #fff !important }`}</style>
      <div className="mb-6 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium tracking-wide uppercase" style={{ color }}>
            {studio}
          </div>
          <h1 className="mt-1 text-2xl font-bold">
            {config.icon} {row.agent.name}
          </h1>
          <div className="mt-1 text-[#6b7280]">
            {row.client} · {L("отчёт на", "звіт на")} {fmt.format(new Date())} · {model}
          </div>
        </div>
        <PrintButton />
      </div>

      <div className="mb-6 grid grid-cols-4 gap-3">
        {[
          [L("Разговоров за 30 дней", "Розмов за 30 днів"), String(conv30)],
          [L("Ответов агента", "Відповідей агента"), String(replies30)],
          [L("Передач менеджеру за 7 дней", "Передач менеджеру за 7 днів"), String(stats.handoffs)],
          owner ? [L("Включено модулей", "Увімкнено модулів"), `${MODULES.filter((m) => m.on(config)).length}/${MODULES.length}`] : [L("Расходы ИИ за месяц", "Витрати ШІ за місяць"), `$${Number(cost?.total ?? 0).toFixed(2)}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-[#e5e7eb] p-3">
            <div className="text-xl font-bold">{v}</div>
            <div className="text-xs text-[#6b7280]">{k}</div>
          </div>
        ))}
      </div>

      {/* Схема: каналы → ядро → группы */}
      <div className="mb-6 grid grid-cols-[1fr_auto_1fr_auto_1.6fr] items-center gap-3 rounded-2xl border border-[#e5e7eb] p-4">
        <div className="space-y-1.5">
          {chs.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-[#e5e7eb] px-2 py-1">
              <span className="grid size-6 place-items-center rounded-md text-[9px] font-bold text-white" style={{ background: c.enabled ? (CHANNEL_BRAND[c.type]?.color ?? "#64748b") : "#cbd5e1" }}>
                {CHANNEL_BRAND[c.type]?.short ?? "?"}
              </span>
              <span className="min-w-0 truncate">{CHANNEL_LABEL[c.type] ?? c.type}</span>
              <span className="ml-auto text-xs text-[#6b7280]">{sum(stats.daily.channels[c.id])}</span>
            </div>
          ))}
          {chs.length === 0 && <div className="text-xs text-[#6b7280]">{L("Каналов нет", "Каналів немає")}</div>}
        </div>
        <span style={{ color }}>→</span>
        <div className="rounded-xl border-2 p-3 text-center" style={{ borderColor: color }}>
          <div className="text-2xl">{config.icon}</div>
          <div className="font-semibold">{row.agent.name}</div>
          <div className="text-xs text-[#6b7280]">{model}</div>
        </div>
        <span style={{ color }}>→</span>
        <div className="grid grid-cols-2 gap-1.5">
          {GROUPS.map((g) => {
            const mods = MODULES.filter((m) => m.group === g.key);
            const on = mods.filter((m) => m.on(config));
            return (
              <div key={g.key} className="rounded-lg border border-[#e5e7eb] px-2 py-1">
                <div className="text-xs font-semibold">{g.title[locale]}</div>
                <div className="text-[11px] text-[#6b7280]">
                  {on.length}/{mods.length} {L("включено", "увімкнено")}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <h2 className="mb-2 text-sm font-semibold">{L("Модули", "Модулі")}</h2>
      <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-1">
        {MODULES.filter((m) => m.on(config)).map((m) => (
          <div key={m.key} className="flex items-center gap-2 border-b border-[#f1f5f9] py-1">
            <span className="size-2 rounded-full bg-[#10b981]" />
            <span className="min-w-0 flex-1 truncate">{m.title[locale]}</span>
            <span className="text-xs text-[#6b7280]">{sum(stats.daily.modules[m.key]) ? `${sum(stats.daily.modules[m.key])} ${L("за 30 дн.", "за 30 дн.")}` : ""}</span>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-sm font-semibold">{L("Изменения за месяц", "Зміни за місяць")}</h2>
      {changes.length === 0 ? (
        <p className="text-[#6b7280]">{L("Модули в этом месяце не менялись.", "Модулі цього місяця не змінювалися.")}</p>
      ) : (
        <ul className="space-y-0.5">
          {changes.map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-12 shrink-0 text-[#6b7280]">{short.format(new Date(c.at))}</span>
              <span className={c.on ? "text-[#059669]" : "text-[#dc2626]"}>{c.on ? "+" : "−"}</span>
              <span>{title(c.key)}</span>
              <span className="text-[#6b7280]">v{c.version}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
