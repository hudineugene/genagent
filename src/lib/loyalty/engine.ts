import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { channels, conversations, loyaltyAccounts, loyaltyPrograms, loyaltyTx, type LoyaltyAccount, type LoyaltyProgram } from "@/db/schema";
import type { ToolContext } from "@/lib/agent/tools";
import type { AgentTool } from "@/lib/llm";

/**
 * Баллы и лояльность: счёт по контакту, начисления из студии, из CRM/сайта (API) и обмен на награды через агента.
 * Баланс меняется одной операцией с проверкой «не ниже нуля» — двойное списание невозможно.
 */
export const newApiKey = () => `lp_${randomBytes(18).toString("base64url")}`;

/** Контакт → ключ счёта: почта строчными, ник без @ строчными, телефон / id — цифрами. */
export function normContact(raw: string) {
  const s = raw.trim().replace(/^dm:/, "");
  if (!s) return "";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return s.toLowerCase();
  if (s.startsWith("@")) return s.slice(1).toLowerCase();
  if (/^[+\d][\d\s()+-]{3,}$/.test(s)) return s.replace(/\D/g, "");
  return s.toLowerCase();
}

/** Возможные ключи счёта собеседника: ник, id чата / телефон WhatsApp, почта. */
export function conversationKeys(c: { externalId: string; contactHandle: string }) {
  return [...new Set([normContact(c.contactHandle), normContact(c.externalId)].filter(Boolean))];
}

export async function getProgram(id: string) {
  const [p] = await db.select().from(loyaltyPrograms).where(eq(loyaltyPrograms.id, id));
  return p ?? null;
}

/** Изменить баланс. null — не хватает баллов. */
export async function addPoints(account: Pick<LoyaltyAccount, "id">, delta: number, reason: string, source: "studio" | "api" | "agent" | "welcome") {
  const [row] = await db
    .update(loyaltyAccounts)
    .set({ balance: sql`${loyaltyAccounts.balance} + ${delta}`, updatedAt: new Date() })
    .where(and(eq(loyaltyAccounts.id, account.id), sql`${loyaltyAccounts.balance} + ${delta} >= 0`))
    .returning();
  if (!row) return null;
  await db.insert(loyaltyTx).values({ accountId: row.id, delta, balance: row.balance, reason: reason.slice(0, 300), source });
  return row;
}

/** Найти счёт по контакту или создать (с приветственным бонусом). */
export async function ensureAccount(p: LoyaltyProgram, keys: string[], init: { name?: string; conversationId?: string | null } = {}) {
  const list = keys.filter(Boolean);
  if (!list.length) throw new Error("no_contact");
  const [found] = await db.select().from(loyaltyAccounts).where(and(eq(loyaltyAccounts.programId, p.id), inArray(loyaltyAccounts.contact, list)));
  if (found) {
    if ((init.conversationId && init.conversationId !== found.conversationId) || (init.name && !found.name)) {
      await db
        .update(loyaltyAccounts)
        .set({ conversationId: init.conversationId ?? found.conversationId, name: found.name || init.name || "" })
        .where(eq(loyaltyAccounts.id, found.id));
    }
    return { account: found, created: false };
  }
  const [created] = await db
    .insert(loyaltyAccounts)
    .values({ programId: p.id, contact: list[0], name: (init.name ?? "").slice(0, 100), conversationId: init.conversationId ?? null })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [again] = await db.select().from(loyaltyAccounts).where(and(eq(loyaltyAccounts.programId, p.id), eq(loyaltyAccounts.contact, list[0])));
    return { account: again, created: false };
  }
  if (p.welcome > 0) {
    const withBonus = await addPoints(created, p.welcome, "Приветственный бонус", "welcome");
    return { account: withBonus ?? created, created: true };
  }
  return { account: created, created: true };
}

const plural = (p: LoyaltyProgram, n: number) => `${n} ${p.unit}`;

/** Начисление или списание из студии / API: история, событие, сообщение клиенту в чат. */
export async function adjust(p: LoyaltyProgram, account: LoyaltyAccount, delta: number, reason: string, source: "studio" | "api") {
  const row = await addPoints(account, delta, reason, source);
  if (!row) return { error: "insufficient" as const };
  void import("@/lib/integrations/events").then((e) =>
    e.emitEvent("points", { clientId: p.clientId, conversationId: row.conversationId, points: { program: p.name, contact: row.name || row.contact, delta, balance: row.balance, reason } }),
  );
  if (p.notifyCustomer && row.conversationId) {
    const text = `${delta > 0 ? `🎁 +${plural(p, delta)}` : `➖ ${plural(p, -delta)}`}${reason ? `: ${reason}` : ""}. Ваш баланс: ${plural(p, row.balance)}.`;
    await sayToCustomer(row.conversationId, text).catch((e) => console.error("loyalty notify failed", e));
  }
  return { account: row };
}

async function sayToCustomer(conversationId: string, text: string) {
  const [r] = await db
    .select({ conversation: conversations, channel: channels })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  if (!r) return;
  const { addMessage, deliver } = await import("@/lib/conversations");
  const externalId = await deliver(r.channel, r.conversation, text);
  await addMessage(conversationId, "assistant", text, { externalId: externalId ?? undefined });
}

async function accountFor(p: LoyaltyProgram, ctx: ToolContext) {
  if (!ctx.conversationId) return null;
  const [c] = await db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
  if (!c) return null;
  return (await ensureAccount(p, conversationKeys(c), { name: c.contactName, conversationId: c.id })).account;
}

export function loyaltyTools(p: LoyaltyProgram, ctx: ToolContext & { clientId: string }): AgentTool[] {
  const rewards = p.rewards.map((r) => `${r.name} — ${plural(p, r.cost)}`).join("; ") || "—";
  return [
    {
      name: "loyalty_balance",
      description: `Customer's points balance in the loyalty program «${p.name}», recent operations and available rewards. Use when the customer asks about points, bonuses or what they can get.`,
      inputSchema: { type: "object", properties: {} },
      parse: z.object({}).passthrough(),
      run: async () => {
        if (ctx.mode !== "live") return `[Test mode: balance 120 ${p.unit}. Rewards: ${rewards}]`;
        const a = await accountFor(p, ctx);
        if (!a) return "Balance is not available in this chat.";
        const tx = await db.select().from(loyaltyTx).where(eq(loyaltyTx.accountId, a.id)).orderBy(desc(loyaltyTx.createdAt)).limit(5);
        const affordable = p.rewards.filter((r) => r.cost <= a.balance).map((r) => r.name);
        return [
          `Balance: ${plural(p, a.balance)}.`,
          `Rewards: ${rewards}.`,
          affordable.length ? `Available now: ${affordable.join(", ")}.` : "Not enough for any reward yet.",
          tx.length ? `Recent: ${tx.map((t) => `${t.delta > 0 ? "+" : ""}${t.delta} ${t.reason}`).join("; ")}.` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "loyalty_redeem",
      description: `Exchange the customer's points for a reward of «${p.name}». Only when the customer clearly confirmed which reward they want. Rewards: ${rewards}.`,
      inputSchema: { type: "object", properties: { reward: { type: "string", description: "Reward name exactly as in the list" } }, required: ["reward"] },
      parse: z.object({ reward: z.string().trim().min(1).max(200) }),
      run: async (input) => {
        const name = (input as { reward: string }).reward.toLowerCase();
        const r = p.rewards.find((x) => x.name.toLowerCase() === name) ?? p.rewards.find((x) => x.name.toLowerCase().includes(name) || name.includes(x.name.toLowerCase()));
        if (!r) return `Unknown reward. Available: ${rewards}.`;
        if (ctx.mode !== "live") return `[Test mode: would exchange ${r.cost} ${p.unit} for «${r.name}»]`;
        const a = await accountFor(p, ctx);
        if (!a) return "Points are not available in this chat.";
        const row = await addPoints(a, -r.cost, `Обмен: ${r.name}`, "agent");
        if (!row) return `Not enough points: balance ${plural(p, a.balance)}, «${r.name}» costs ${plural(p, r.cost)}.`;
        void import("@/lib/integrations/events").then((e) =>
          e.emitEvent("points", { clientId: p.clientId, agentId: ctx.agentId, conversationId: ctx.conversationId, points: { program: p.name, contact: row.name || row.contact, delta: -r.cost, balance: row.balance, reason: `Обмен: ${r.name}` } }),
        );
        void import("@/lib/notify/telegram").then(async (n) => {
          const html = `🎁 <b>Обмен баллов</b> · ${p.name}\n${(row.name || row.contact).replace(/</g, "&lt;")} обменял(а) ${plural(p, r.cost)} на «${r.name.replace(/</g, "&lt;")}». Остаток: ${plural(p, row.balance)}.\nВыдайте награду.`;
          await n.sendToTeam(html);
          await n.sendToOwners(p.clientId, html);
        });
        return `Done: «${r.name}» for ${plural(p, r.cost)}. New balance: ${plural(p, row.balance)}. Tell the customer the manager will contact them to hand over the reward.`;
      },
    },
  ];
}

export function loyaltyNote(p: LoyaltyProgram | null) {
  if (!p) return "";
  return [
    `# Программа лояльности «${p.name}»`,
    "Баланс и награды смотри инструментом loyalty_balance, обмен — loyalty_redeem (только после явного подтверждения клиента). Не обещай начислений, которых нет в правилах.",
    p.rules ? `Как начисляются: ${p.rules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
