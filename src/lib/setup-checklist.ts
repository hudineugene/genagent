import "server-only";
import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, knowledgeGaps, type ApiConfig } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Что ещё не настроено у агентов: подписка владельца, поля карточки лида, просьба оценить ответ, голосовые ответы,
 * тестовые аккаунты, бот уведомлений, проверка после изменений. Показываем на «Сегодня» и в карточке агента со ссылкой
 * туда, где это включается. Ненужный пункт можно скрыть («Не нужно») — он больше не показывается.
 */
export type SetupItem = {
  /** Стабильный ключ пункта (для «Не нужно»): тип и id агента/клиента */
  key: string;
  kind: "owner" | "leadFields" | "rating" | "voice" | "testAccounts" | "notify" | "autoTests" | "gapsWaiting";
  agentId?: string;
  title: string;
  /** Подстановки для текста: число вопросов и т.п. */
  n?: number;
  href: string;
};

const DISMISSED = "setupDismissed";

export async function dismissedSetup(): Promise<string[]> {
  return (await getSetting<string[]>(DISMISSED)) ?? [];
}

export async function dismissSetupItem(key: string) {
  const list = await dismissedSetup();
  if (!list.includes(key)) await setSetting(DISMISSED, [...list, key].slice(-200));
}

/** Пункты для активных агентов (и общие). agentId — только для одного агента (карточка агента). */
export async function setupChecklist(agentId?: string): Promise<SetupItem[]> {
  const rows = await db
    .select({ agent: agents, client: clients })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(agentId ? eq(agents.id, agentId) : eq(agents.status, "active"));
  const { getNotifySettings } = await import("@/lib/notify/telegram");
  const notify = await getNotifySettings();
  const items: SetupItem[] = [];

  if (!agentId) {
    if (!notify?.token || !notify.subscribers.length) items.push({ key: "notify", kind: "notify", title: "", href: "/integrations" });
    const { getTestAccounts } = await import("@/lib/test-accounts");
    if (!(await getTestAccounts()).length) items.push({ key: "testAccounts", kind: "testAccounts", title: "", href: "/team" });
    const { getAutoTests } = await import("@/lib/tests/auto");
    if (!(await getAutoTests()).enabled) items.push({ key: "autoTests", kind: "autoTests", title: "", href: "/integrations?tab=reports" });
  }

  for (const { agent, client } of rows) {
    const title = `${client.name} · ${agent.name}`;
    const cfg = agent.config as { leadFields?: string; voiceReplies?: boolean };
    const owners = (notify?.owners ?? []).filter((o) => o.clientId === client.id);
    const [{ open }] = await db
      .select({ open: count() })
      .from(knowledgeGaps)
      .where(and(eq(knowledgeGaps.agentId, agent.id), eq(knowledgeGaps.status, "open")));
    if (notify?.token && !owners.length) {
      items.push(
        open
          ? { key: `gapsWaiting:${client.id}`, kind: "gapsWaiting", agentId: agent.id, title, n: open, href: `/clients/${client.id}` }
          : { key: `owner:${client.id}`, kind: "owner", agentId: agent.id, title, href: `/clients/${client.id}` },
      );
    }
    if (!cfg.leadFields?.trim()) items.push({ key: `leadFields:${agent.id}`, kind: "leadFields", agentId: agent.id, title, href: `/agents/${agent.id}` });
    const chans = await db.select({ type: channels.type, config: channels.config, enabled: channels.enabled }).from(channels).where(eq(channels.agentId, agent.id));
    if (chans.some((c) => c.enabled && c.type === "api" && !(c.config as ApiConfig).ratingInvite)) {
      items.push({ key: `rating:${agent.id}`, kind: "rating", agentId: agent.id, title, href: `/agents/${agent.id}/channels` });
    }
    if (cfg.voiceReplies !== false && !process.env.OPENAI_API_KEY && chans.some((c) => c.enabled && (c.type === "api" || c.type === "telegram"))) {
      items.push({ key: `voice:${agent.id}`, kind: "voice", agentId: agent.id, title, href: `/agents/${agent.id}` });
    }
  }
  // Один клиент — один пункт про владельца, даже если агентов несколько
  const seen = new Set<string>();
  const dismissed = new Set(await dismissedSetup());
  return items.filter((i) => {
    if (dismissed.has(i.key) || seen.has(i.key)) return false;
    seen.add(i.key);
    return true;
  });
}
