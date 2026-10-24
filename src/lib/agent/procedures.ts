import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientTools, conversations, procedures, type Procedure, type ProcedureState, type ProcedureStep } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import type { ToolContext } from "./tools";

/**
 * Процедуры с обязательными шагами. Агент вызывает start_procedure, когда ситуация подходит; дальше ответы клиенту
 * пишет программа: вопрос — проверка ответа (повтор с подсказкой) — запрос к системе — согласование — итог.
 * «Отмена» останавливает процедуру; процедура без движения дольше суток забывается. Согласование ждёт решения
 * руководителя (кнопки в Telegram или студия), клиент тем временем говорит с агентом как обычно.
 */
const IDLE_MS = 24 * 3600_000;
const MAX_RETRIES = 2;
const CANCEL_RE = /^\s*(отмена|отменить|стоп|cancel|скасувати|скасуй|не надо|не треба)\s*[.!]?\s*$/i;

export async function loadProcedures(clientId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(procedures).where(and(eq(procedures.clientId, clientId), inArray(procedures.id, ids), eq(procedures.enabled, true)));
}

/** Подстановка {ключ} из собранных ответов. */
export function fill(text: string, data: Record<string, string>) {
  return text.replace(/\{([a-z0-9_]+)\}/gi, (_m, k: string) => data[k] ?? "");
}

/** Проверка ответа на вопрос: нормализованное значение или null. */
export function validate(step: Extract<ProcedureStep, { kind: "ask" }>, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (step.type) {
    case "phone": {
      const d = v.replace(/[^\d+]/g, "");
      return d.replace(/\D/g, "").length >= 9 && d.replace(/\D/g, "").length <= 15 ? d : null;
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v.toLowerCase() : null;
    case "number": {
      const m = v.replace(/\s/g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
      return m ? m[0] : null;
    }
    case "date": {
      const m = v.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/) ?? v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      if (m[1].length === 4) return `${m[1]}-${m[2]}-${m[3]}`;
      const y = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(new Date().getFullYear());
      return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    case "choice": {
      const opts = step.options ?? [];
      const n = Number(v.replace(/\D/g, ""));
      if (/^\d+$/.test(v) && n >= 1 && n <= opts.length) return opts[n - 1];
      return opts.find((o) => o.toLowerCase() === v.toLowerCase()) ?? opts.find((o) => v.toLowerCase().includes(o.toLowerCase())) ?? null;
    }
    default:
      return v.slice(0, 1000);
  }
}

type Lang = "ru" | "uk" | "en";
const T: Record<Lang, Record<string, string>> = {
  ru: {
    phone: "Нужен номер телефона, например +380 67 123 45 67.",
    email: "Нужен адрес почты, например name@mail.com.",
    number: "Нужно число.",
    date: "Нужна дата, например 15.11.2026.",
    choice: "Выберите один из вариантов (можно номером).",
    text: "Напишите, пожалуйста, ответ.",
    sent: "Передал заявку №{n} на согласование. Ответ придёт сюда, в этот чат.",
    stopped: "Хорошо, остановил. Если понадобится — просто напишите.",
    giveUp: "Не получается разобрать ответ — передаю менеджеру, он поможет.",
    rejected: "К сожалению, заявку не согласовали.",
  },
  uk: {
    phone: "Потрібен номер телефону, наприклад +380 67 123 45 67.",
    email: "Потрібна адреса пошти, наприклад name@mail.com.",
    number: "Потрібне число.",
    date: "Потрібна дата, наприклад 15.11.2026.",
    choice: "Оберіть один із варіантів (можна номером).",
    text: "Напишіть, будь ласка, відповідь.",
    sent: "Передав заявку №{n} на погодження. Відповідь прийде сюди, в цей чат.",
    stopped: "Добре, зупинив. Якщо знадобиться — просто напишіть.",
    giveUp: "Не вдається розібрати відповідь — передаю менеджеру, він допоможе.",
    rejected: "На жаль, заявку не погодили.",
  },
  en: {
    phone: "Please send a phone number, e.g. +380 67 123 45 67.",
    email: "Please send an email address, e.g. name@mail.com.",
    number: "Please send a number.",
    date: "Please send a date, e.g. 15.11.2026.",
    choice: "Please choose one of the options (a number is fine).",
    text: "Please write your answer.",
    sent: "I've sent request №{n} for approval. The answer will come here, in this chat.",
    stopped: "OK, stopped. Just write if you need anything.",
    giveUp: "I can't make out the answer — passing you to a manager who will help.",
    rejected: "Unfortunately, the request was not approved.",
  },
};
const langOf = (l?: string): Lang => (l?.startsWith("uk") || l?.startsWith("ua") ? "uk" : l?.startsWith("en") ? "en" : "ru");

function question(step: Extract<ProcedureStep, { kind: "ask" }>, data: Record<string, string>) {
  const q = fill(step.question, data);
  return step.type === "choice" && step.options?.length ? `${q}\n${step.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : q;
}

type Out = { messages: string[]; state: ProcedureState | null; handoff?: boolean };

/** Выполнить шаги начиная с state.step до следующего вопроса, согласования или конца. */
async function run(proc: Procedure, state: ProcedureState, ctx: { clientId: string; agentId: string; conversationId: string; live: boolean; lang: Lang }): Promise<Out> {
  const messages: string[] = [];
  const data = { ...state.data };
  for (let i = state.step; i < proc.steps.length; i++) {
    const s = proc.steps[i];
    if (s.kind === "ask") return { messages: [...messages, question(s, data)], state: { ...state, step: i, data, at: Date.now(), retries: 0 } };
    if (s.kind === "say") {
      messages.push(fill(s.text, data));
      continue;
    }
    if (s.kind === "handoff") {
      messages.push(fill(s.text, data));
      return { messages, state: null, handoff: true };
    }
    if (s.kind === "tool") {
      data[s.saveAs] = await runTool(s, data, ctx).catch((e) => `ошибка: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (s.kind === "approval") {
      if (!ctx.live) {
        messages.push(`[Тест: заявка «${fill(s.subject, data)}» не отправлена руководителю — считаем, что согласовано]`);
        continue;
      }
      const { createApproval } = await import("@/lib/team/approvals");
      const [conv] = await db.select({ name: conversations.contactName, handle: conversations.contactHandle }).from(conversations).where(eq(conversations.id, ctx.conversationId));
      const a = await createApproval({
        clientId: ctx.clientId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        requester: [conv?.name, conv?.handle].filter(Boolean).join(" ").slice(0, 200),
        subject: fill(s.subject, data).slice(0, 200),
        details: fill(s.details, data).slice(0, 3000),
        amount: fill(s.amount ?? "", data).slice(0, 100),
      });
      void import("@/lib/notify/telegram").then((n) => n.notifyApproval(a, "both")).catch((e) => console.error("procedure approval notify failed", e));
      messages.push(T[ctx.lang].sent.replace("{n}", String(a.number)));
      return { messages, state: { ...state, step: i, data, at: Date.now(), waiting: a.id } };
    }
  }
  return { messages, state: null };
}

async function runTool(s: Extract<ProcedureStep, { kind: "tool" }>, data: Record<string, string>, ctx: { clientId: string; live: boolean }) {
  const [tool] = await db.select().from(clientTools).where(and(eq(clientTools.id, s.toolId), eq(clientTools.clientId, ctx.clientId)));
  if (!tool) return "нет инструмента";
  const args = Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, fill(v, data)]));
  if (tool.kind === "crm") {
    const crm = await import("@/lib/crm");
    const cfg = tool.config as unknown as import("@/lib/crm").CrmConfig;
    return s.action === "find" ? crm.findCustomer(cfg, { phone: args.phone, email: args.email }) : crm.orderStatus(cfg, args.order ?? Object.values(args)[0] ?? "");
  }
  const { callTool, searchSheetTool } = await import("./custom-tools");
  if (tool.kind === "sheet") return searchSheetTool(tool, args.query ?? Object.values(args).join(" "));
  return callTool(tool, args, { dry: !ctx.live });
}

/** Инструмент агента: запустить процедуру. Ответ клиенту вместо агента пишет программа (первый шаг). */
export function procedureTool(list: Procedure[], ctx: ToolContext & { clientId: string }): AgentTool {
  return {
    name: "start_procedure",
    description: `Start a fixed step-by-step procedure when the situation matches. The program will then talk to the customer itself (questions, checks, approval). Procedures:\n${list.map((p) => `- "${p.name}": ${p.trigger}`).join("\n")}`,
    inputSchema: { type: "object", properties: { name: { type: "string", enum: list.map((p) => p.name) } }, required: ["name"] },
    parse: z.object({ name: z.string().min(1).max(100) }),
    run: async (input) => {
      const proc = list.find((p) => p.name === (input as { name: string }).name);
      if (!proc) return "No such procedure.";
      if (!ctx.conversationId) return "Started.";
      const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, ctx.conversationId));
      await db
        .update(conversations)
        .set({ context: { ...cur?.context, procedure: { id: proc.id, step: 0, data: {}, at: Date.now() } } })
        .where(eq(conversations.id, ctx.conversationId));
      return `Procedure «${proc.name}» started. The program now writes to the customer — keep your reply very short or empty.`;
    },
  };
}

export const proceduresNote = (list: Procedure[]) =>
  list.length
    ? `# Процедуры\nДля этих ситуаций есть обязательный порядок — запускай инструментом start_procedure, сам шаги не веди:\n${list.map((p) => `• «${p.name}» — ${p.trigger}`).join("\n")}`
    : "";

/** Сообщение клиента в идущей процедуре: ответ программы, новое состояние. null — процедуры нет (отвечает агент). */
export async function handleProcedureMessage(conv: { id: string; clientId: string; agentId: string; context: { procedure?: ProcedureState; language?: string } | null }, text: string, live = true): Promise<Out | null> {
  const state = conv.context?.procedure;
  const lang = langOf(conv.context?.language);
  if (!state || state.waiting) return null;
  if (Date.now() - state.at > IDLE_MS) {
    await saveState(conv.id, null);
    return null;
  }
  const [proc] = await db.select().from(procedures).where(eq(procedures.id, state.id));
  if (!proc) {
    await saveState(conv.id, null);
    return null;
  }
  if (CANCEL_RE.test(text)) {
    await saveState(conv.id, null);
    return { messages: [T[lang].stopped], state: null };
  }
  const step = proc.steps[state.step];
  if (step?.kind === "ask") {
    const value = validate(step, text);
    if (value === null) {
      const retries = (state.retries ?? 0) + 1;
      // Дважды не получилось — передаём менеджеру, а не мучаем клиента
      if (retries > MAX_RETRIES) {
        await saveState(conv.id, null);
        return { messages: [T[lang].giveUp], state: null, handoff: true };
      }
      await saveState(conv.id, { ...state, retries, at: Date.now() });
      return { messages: [`${T[lang][step.type] ?? T[lang].text}\n${question(step, state.data)}`], state: { ...state, retries } };
    }
    const next = { ...state, step: state.step + 1, data: { ...state.data, [step.key]: value } };
    const out = await run(proc, next, { clientId: conv.clientId, agentId: conv.agentId, conversationId: conv.id, live, lang });
    await saveState(conv.id, out.state);
    return out;
  }
  const out = await run(proc, state, { clientId: conv.clientId, agentId: conv.agentId, conversationId: conv.id, live, lang });
  await saveState(conv.id, out.state);
  return out;
}

/** Процедура только что запущена агентом: первый шаг (вопрос или сообщения). */
export async function startedProcedureOutput(conv: { id: string; clientId: string; agentId: string }, live = true): Promise<Out | null> {
  const [c] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conv.id));
  const state = c?.context?.procedure;
  if (!state || state.step !== 0 || Object.keys(state.data).length) return null;
  const [proc] = await db.select().from(procedures).where(eq(procedures.id, state.id));
  if (!proc) return null;
  const out = await run(proc, state, { ...conv, conversationId: conv.id, live, lang: langOf(c?.context?.language) });
  await saveState(conv.id, out.state);
  return out;
}

/** Решение по согласованию процедуры: продолжить (согласовано) или сообщить отказ. Сообщения — для клиента. */
export async function resumeAfterApproval(conversationId: string, approvalId: string, approved: boolean): Promise<Out | null> {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  const state = c?.context?.procedure;
  if (!c || !state || state.waiting !== approvalId) return null;
  const [proc] = await db.select().from(procedures).where(eq(procedures.id, state.id));
  const step = proc?.steps[state.step];
  if (!proc || step?.kind !== "approval") {
    await saveState(c.id, null);
    return null;
  }
  if (!approved) {
    await saveState(c.id, null);
    return { messages: [fill(step.rejected || T[langOf(c.context?.language)].rejected, state.data)], state: null };
  }
  const out = await run(proc, { ...state, step: state.step + 1, waiting: undefined }, { clientId: c.clientId, agentId: c.agentId, conversationId: c.id, live: true, lang: langOf(c.context?.language) });
  await saveState(c.id, out.state);
  return out;
}

async function saveState(conversationId: string, state: ProcedureState | null) {
  const [cur] = await db.select({ context: conversations.context }).from(conversations).where(eq(conversations.id, conversationId));
  const context = { ...cur?.context };
  if (state) context.procedure = state;
  else delete context.procedure;
  await db.update(conversations).set({ context }).where(eq(conversations.id, conversationId));
}
