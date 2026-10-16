import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, type TeamState } from "@/db/schema";

/**
 * Честный срок ответа, когда агент передаёт клиента менеджеру. Свой бот знает расписание компании
 * и присылает с вопросом клиента team: открыто ли сейчас, когда откроются, за сколько обычно отвечают.
 * Если бот этого не прислал — берём свои замеры: за 30 дней от передачи менеджеру до первого ответа
 * сотрудника (медиана, не меньше 5 случаев). Нет данных — агент срок не называет.
 */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SAMPLES = 5;
const CACHE_MS = 10 * 60 * 1000;
/** Сведения бота о команде годятся, пока свежие (бот шлёт их с каждым вопросом) */
const TEAM_FRESH_MS = 15 * 60 * 1000;

const cache = new Map<string, { at: number; minutes: number | null }>();

/** Медиана минут от передачи менеджеру до ответа сотрудника в канале (null — мало данных). */
export async function measuredReplyMinutes(channelId: string): Promise<number | null> {
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.minutes;
  const since = new Date(Date.now() - WINDOW_MS);
  const rows = await db
    .select({ conversationId: messages.conversationId, role: messages.role, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    // тестовые разговоры — не в счёт
    .where(and(eq(conversations.channelId, channelId), eq(conversations.isTest, false), gt(messages.createdAt, since), inArray(messages.role, ["system", "operator"])));
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) byConv.set(r.conversationId, [...(byConv.get(r.conversationId) ?? []), r]);
  const samples: number[] = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let start: number | null = null;
    for (const m of list) {
      if (m.role === "system" && m.text === "handoff") start ??= m.createdAt.getTime();
      else if (m.role === "operator" && start !== null) {
        const min = (m.createdAt.getTime() - start) / 60000;
        if (min <= 3 * 24 * 60) samples.push(min);
        start = null;
      }
    }
  }
  samples.sort((a, b) => a - b);
  const minutes = samples.length >= MIN_SAMPLES ? Math.max(1, Math.round(samples[Math.floor((samples.length - 1) / 2)])) : null;
  cache.set(channelId, { at: Date.now(), minutes });
  return minutes;
}

const span = (m: number) => (m < 60 ? `${m} мин` : m < 24 * 60 ? `${Math.round(m / 60)} ч` : `${Math.round(m / 1440)} дн`);

/** Раздел контекста агента: что честно сказать клиенту о сроке ответа менеджера. */
export function handoffEtaNote(team: TeamState | undefined, measured: number | null): string {
  const fresh = team && Date.now() - team.at < TEAM_FRESH_MS ? team : undefined;
  const lines = ["# Если передаёшь клиента менеджеру — честный срок ответа"];
  if (fresh && !fresh.open) {
    lines.push(
      `Сейчас нерабочее время команды.${fresh.next ? ` Менеджер ответит ${fresh.next}.` : " Менеджер ответит в ближайшее рабочее время."} Так и скажи клиенту — не обещай ответ «скоро» или «сегодня», если это не так. Предложи оставить вопрос подробно, чтобы утром ответили сразу по делу.`,
    );
  } else {
    const minutes = fresh ? (fresh.minutes ?? null) : measured;
    lines.push(
      minutes
        ? `Сейчас ${fresh ? "рабочее время" : "команда на связи"}; обычно менеджер отвечает примерно за ${span(minutes)}${fresh ? "" : " (по данным за последний месяц)"}. Назови клиенту этот срок своими словами («обычно отвечаем примерно за …»), без точного обещания.`
        : "Точного срока ответа менеджера нет — не называй минут и часов и не обещай «сейчас ответят». Скажи, что передал вопрос и менеджер ответит, как только освободится.",
    );
  }
  return lines.join("\n");
}
