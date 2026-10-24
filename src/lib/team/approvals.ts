import "server-only";
import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, approvals, channels, conversations, type Approval } from "@/db/schema";
import type { AgentConfig } from "@/lib/agent/types";
import type { ToolContext } from "@/lib/agent/tools";
import type { AgentTool } from "@/lib/llm";

/**
 * Агенты для сотрудников: доступ по списку (кто может писать агенту) и заявки на согласование
 * у руководителя (кнопки в Telegram или в студии), ответ сотруднику приходит в тот же чат.
 */
export type TeamConfig = NonNullable<AgentConfig["team"]>;

const digits = (s: string) => s.replace(/\D/g, "");
const norm = (s: string) => s.trim().toLowerCase().replace(/^@/, "");

/** Есть ли собеседник в списке: @username, id Telegram, телефон (по цифрам), почта; «*» — все. */
export function isAllowed(allowed: string, who: { externalId: string; handle: string }) {
  const list = allowed
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.includes("*")) return true;
  const ids = [who.externalId, who.handle].filter(Boolean);
  return list.some((entry) => {
    const e = norm(entry);
    if (!e) return false;
    // Телефон или числовой id: сравниваем цифры (+380 67… = 38067…)
    if (/^[+\d][\d\s()+-]{4,}$/.test(entry.trim())) {
      const d = digits(entry);
      // Телефон в местном или международном виде (+380…, 067…) — по последним 9 цифрам; id Telegram — только точно
      const phone = /^[+0]/.test(entry.trim()) && d.length >= 9;
      return ids.some((x) => digits(x) === d || (phone && digits(x).length >= 9 && digits(x).slice(-9) === d.slice(-9)));
    }
    return ids.some((x) => norm(x) === e || norm(x.replace(/^dm:/, "")) === e);
  });
}

/** Подсказка агенту для сотрудников. */
export function teamNote(team: TeamConfig | undefined) {
  if (!team?.enabled) return "";
  return [
    "# Ты помощник для сотрудников компании",
    "Тебе пишут сотрудники, а не клиенты: отвечай как коллега — по внутренним правилам, процессам и базе знаний компании, коротко и по делу. Не продавай и не уговаривай.",
    team.approvals
      ? "Если сотрудник просит то, что требует решения руководителя (отпуск, закупка, расход, скидка, исключение из правил), — уточни суть, сумму и сроки и оформи заявку инструментом request_approval. Скажи, что ответ руководителя придёт сюда же. Сам такие решения не принимай."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const NUM_LOCK = new Map<string, Promise<unknown>>();

export async function createApproval(v: { clientId: string; agentId?: string; conversationId?: string; requester: string; subject: string; details: string; amount: string }) {
  // Номер по порядку у клиента; параллельные заявки одного клиента — по очереди
  const prev = NUM_LOCK.get(v.clientId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const [{ n }] = await db.select({ n: max(approvals.number) }).from(approvals).where(eq(approvals.clientId, v.clientId));
    const [row] = await db
      .insert(approvals)
      .values({ ...v, agentId: v.agentId ?? null, conversationId: v.conversationId ?? null, number: (n ?? 0) + 1 })
      .returning();
    return row;
  });
  NUM_LOCK.set(v.clientId, run.catch(() => {}));
  return run;
}

export function approvalTool(team: TeamConfig, ctx: ToolContext & { clientId: string }): AgentTool {
  return {
    name: "request_approval",
    description:
      "Send the employee's request to the manager for a decision (vacation, purchase, expense, discount, exception). Fill subject (short), details (who, what, when, why) and amount if any. The manager's answer will come to this chat.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short title, e.g. «Отпуск 3–7 ноября»" },
        details: { type: "string", description: "Everything the manager needs to decide" },
        amount: { type: "string", description: "Sum with currency, if any" },
      },
      required: ["subject", "details"],
    },
    parse: z.object({ subject: z.string().trim().min(1).max(200), details: z.string().trim().max(3000), amount: z.string().trim().max(100).optional() }),
    run: async (input) => {
      const i = input as { subject: string; details: string; amount?: string };
      if (ctx.mode !== "live") return `[Test mode: request not sent. It would be: «${i.subject}» — ${i.details}${i.amount ? `, ${i.amount}` : ""}]`;
      const [conv] = ctx.conversationId ? await db.select({ name: conversations.contactName, handle: conversations.contactHandle }).from(conversations).where(eq(conversations.id, ctx.conversationId)) : [];
      const a = await createApproval({
        clientId: ctx.clientId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        requester: [conv?.name, conv?.handle].filter(Boolean).join(" ").slice(0, 200),
        subject: i.subject,
        details: i.details,
        amount: i.amount ?? "",
      });
      const sent = await import("@/lib/notify/telegram").then((n) => n.notifyApproval(a, team.approvers)).catch((e) => {
        console.error("approval notify failed", e);
        return 0;
      });
      return sent
        ? `Request №${a.number} sent to the manager. Tell the employee the answer will come here.`
        : `Request №${a.number} saved, but no manager is subscribed to notifications yet — tell the employee it is registered and the manager will see it in the studio.`;
    },
  };
}

/** Решение руководителя: статус, ответ сотруднику в его чат. null — заявки нет или уже решена. */
export async function decideApproval(id: string, approve: boolean, by: string, comment = ""): Promise<Approval | null> {
  const [a] = await db
    .update(approvals)
    .set({ status: approve ? "approved" : "rejected", decidedBy: by.slice(0, 100), comment: comment.slice(0, 1000), decidedAt: new Date() })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning();
  if (!a) return null;
  if (a.conversationId) {
    const [row] = await db
      .select({ conversation: conversations, channel: channels })
      .from(conversations)
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(eq(conversations.id, a.conversationId));
    if (row) {
      const text = `${approve ? "✅ Согласовано" : "❌ Не согласовано"}: заявка №${a.number} «${a.subject}»${by ? ` (${by})` : ""}.${comment ? `\n${comment}` : ""}`;
      const { addMessage, deliver } = await import("@/lib/conversations");
      // Заявка из процедуры: процедура продолжается сама (или сообщает отказ) — без общего текста решения
      const { resumeAfterApproval } = await import("@/lib/agent/procedures");
      const out = await resumeAfterApproval(row.conversation.id, a.id, approve).catch((e) => {
        console.error("procedure resume failed", e);
        return null;
      });
      if (out) {
        const { sendProcedureOutput } = await import("@/lib/conversations");
        await sendProcedureOutput(row.channel, row.conversation, out);
        return a;
      }
      try {
        const externalId = await deliver(row.channel, row.conversation, text);
        await addMessage(row.conversation.id, "assistant", text, { externalId: externalId ?? undefined });
      } catch (e) {
        console.error("approval answer deliver failed", e);
      }
    }
  }
  return a;
}

/** Есть ли у клиента агенты для сотрудников (вкладка «Согласования» нужна только им). */
export async function hasTeamAgents(clientId: string) {
  const list = await db.select({ config: agents.config }).from(agents).where(eq(agents.clientId, clientId));
  return list.some((a) => a.config.team?.enabled);
}
