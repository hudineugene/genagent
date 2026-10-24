import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients, conversations, onboardingPlans, onboardings, type Onboarding, type OnboardingItem, type OnboardingStep } from "@/db/schema";
import type { ToolContext } from "@/lib/agent/tools";
import { generateJson } from "@/lib/llm/anthropic";
import type { AgentTool } from "@/lib/llm";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";
import { addDays, kyivNow, parseContact, reach } from "@/lib/reach";

/**
 * Адаптация нового сотрудника: план из шаблона (шаги по дням от выхода) + до 5 пунктов под его должность от ИИ,
 * приветственное письмо (в чат с агентом команды или на почту), каждое утро — что сегодня по плану новичку и
 * знакомства — команде, просрочки — руководителю. Отметки «сделано» — в студии или в чате с агентом команды.
 */
const MODEL = "claude-haiku-5-5";
const MORNING_HOUR = 9;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

type Draft = { name: string; role: string; contact: string; email: string; channelId: string | null; startDate: string; notes: string; planId: string | null; personalize: boolean };

async function personalize(company: string, d: Draft, steps: OnboardingStep[], welcomeBrief: string) {
  const key = apiKey("anthropic");
  if (!key) return null;
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ extra: { title: string; day: number; kind: string }[]; welcome: string }>(key, MODEL, {
    system: [
      `Ты HR-помощник компании «${company}». Новый сотрудник выходит ${d.startDate}.`,
      "extra — до 5 дополнительных пунктов адаптации именно под его должность и заметки руководителя (чего нет в общем плане): что изучить, с кем познакомиться, какие доступы получить. day — день от выхода (0 — первый день). kind: task | meet | read. Не повторяй пункты общего плана; если добавить нечего — пустой список.",
      `welcome — приветственное письмо новичку (80–150 слов): тепло, по делу, что ждёт в первый день (по плану), к кому обращаться. ${welcomeBrief ? `Пожелания компании: ${welcomeBrief}` : ""} Без markdown, на русском.`,
    ].join("\n"),
    prompt: `Имя: ${d.name}. Должность: ${d.role || "—"}. Заметки: ${d.notes || "—"}.\nОбщий план:\n${steps.map((s) => `день ${s.day}: ${s.title}${s.owner ? ` (${s.owner})` : ""}`).join("\n") || "—"}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["extra", "welcome"],
      properties: {
        extra: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "day", "kind"], properties: { title: { type: "string" }, day: { type: "integer" }, kind: { type: "string" } } } },
        welcome: { type: "string" },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "generate", model, usage, ms: Date.now() - started }).catch(() => {});
  return data;
}

function defaultWelcome(company: string, d: Draft, first: OnboardingItem[]) {
  return [
    `${d.name}, добро пожаловать в «${company}»!`,
    `Ждём вас ${d.startDate}.${first.length ? ` В первый день: ${first.map((i) => i.title).join("; ")}.` : ""}`,
    "Я буду напоминать, что по плану, — отмечайте здесь, что сделано, и спрашивайте, если что-то непонятно.",
  ].join("\n");
}

const kindOf = (k: string): OnboardingStep["kind"] => (k === "meet" || k === "read" ? k : "task");

/** Создать адаптацию: чек-лист, приветствие (отправляется сразу). */
async function createOnboarding__(clientId: string, d: Draft) {
  const [plan] = d.planId ? await db.select().from(onboardingPlans).where(and(eq(onboardingPlans.id, d.planId), eq(onboardingPlans.clientId, clientId))) : [];
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
  const steps = plan?.steps ?? [];
  const ai = d.personalize ? await personalize(client?.name ?? "", d, steps, plan?.welcome ?? "").catch((e) => (console.error("onboarding personalize failed", e), null)) : null;
  const all: OnboardingStep[] = [...steps, ...(ai?.extra ?? []).slice(0, 5).map((x) => ({ title: x.title.trim().slice(0, 200), day: Math.min(90, Math.max(0, Math.round(x.day))), kind: kindOf(x.kind), owner: "" }))].filter((s) => s.title);
  const items: OnboardingItem[] = all
    .map((s) => ({ id: randomUUID().slice(0, 8), title: s.title, due: addDays(d.startDate, s.day), kind: s.kind, owner: s.owner, done: false }))
    .sort((a, b) => a.due.localeCompare(b.due));
  const welcomeText = ai?.welcome?.trim() || defaultWelcome(client?.name ?? "", d, items.filter((i) => i.due === d.startDate));
  const [row] = await db
    .insert(onboardings)
    .values({ clientId, planId: plan?.id ?? null, name: d.name, role: d.role, contact: d.contact, email: d.email.toLowerCase(), channelId: d.channelId, startDate: d.startDate, items, welcomeText })
    .returning();
  await sendWelcome(row);
  return row;
}

export async function createOnboarding(clientId: string, d: Draft) {
  return withKeys({ clientId }, () => createOnboarding__(clientId, d));
}

const keysOf = (o: Pick<Onboarding, "contact" | "email">) => ({ ...parseContact(o.contact), email: o.email });

async function sendWelcome(o: Onboarding) {
  let status = "no_contact";
  try {
    const out = await reach(o.clientId, keysOf(o), { text: o.welcomeText, subject: "Добро пожаловать!", name: o.name, mailChannelId: o.channelId });
    if (out.status === "sent") status = "sent";
  } catch (e) {
    console.error("onboarding welcome failed", e);
    status = "failed";
  }
  await db.update(onboardings).set({ welcomeStatus: status, updatedAt: new Date() }).where(eq(onboardings.id, o.id));
  return status;
}

export async function resendWelcome(id: string) {
  const [o] = await db.select().from(onboardings).where(eq(onboardings.id, id));
  return o ? sendWelcome(o) : "not_found";
}

/** Отметить пункт; все сделаны — адаптация завершена (и сообщение команде). */
export async function markItem(id: string, itemId: string, done: boolean) {
  const [o] = await db.select().from(onboardings).where(eq(onboardings.id, id));
  if (!o) return null;
  const today = kyivNow().date;
  const items = o.items.map((i) => (i.id === itemId ? { ...i, done, doneAt: done ? today : undefined } : i));
  const finished = items.length > 0 && items.every((i) => i.done);
  const [row] = await db.update(onboardings).set({ items, status: finished ? "done" : "active", updatedAt: new Date() }).where(eq(onboardings.id, id)).returning();
  if (finished && o.status !== "done") {
    const n = await import("@/lib/notify/telegram");
    const html = `🎓 <b>Адаптация завершена</b>: ${esc(o.name)}${o.role ? ` (${esc(o.role)})` : ""} — все ${items.length} пунктов выполнены.`;
    await n.sendToTeam(html).catch(() => {});
    await n.sendToOwners(o.clientId, html).catch(() => {});
  }
  return row;
}

/** Каждое утро: новичку — что сегодня, команде — знакомства и просрочки. */
export async function onboardingTick(now = new Date()) {
  const k = kyivNow(now);
  if (k.hour < MORNING_HOUR || k.hour >= 21) return 0;
  const list = await db.select().from(onboardings).where(eq(onboardings.status, "active"));
  let n = 0;
  for (const o of list) {
    if (o.lastTick === k.date || o.startDate > k.date) continue;
    const [claimed] = await db.update(onboardings).set({ lastTick: k.date }).where(and(eq(onboardings.id, o.id), eq(onboardings.lastTick, o.lastTick))).returning({ id: onboardings.id });
    if (!claimed) continue;
    const today = o.items.filter((i) => !i.done && i.due === k.date);
    const overdue = o.items.filter((i) => !i.done && i.due < k.date);
    if (today.length) {
      const text = [`Доброе утро, ${o.name}! Сегодня по плану адаптации:`, ...today.map((i) => `• ${i.title}${i.owner ? ` — ${i.owner}` : ""}`), overdue.length ? `\nЕщё не отмечено: ${overdue.map((i) => i.title).join("; ")}.` : "", "\nНапишите, когда сделаете, — я отмечу."]
        .filter(Boolean)
        .join("\n");
      await reach(o.clientId, keysOf(o), { text, subject: "План адаптации на сегодня", name: o.name, mailChannelId: o.channelId }).then(() => n++).catch((e) => console.error("onboarding daily failed", e));
    }
    const meets = today.filter((i) => i.kind === "meet");
    const late = overdue.filter((i) => daysLate(i.due, k.date) >= 1);
    if (meets.length || late.length) {
      const html = [
        `🧭 <b>Адаптация: ${esc(o.name)}</b>${o.role ? ` · ${esc(o.role)}` : ""}`,
        meets.length ? `Сегодня знакомства:\n${meets.map((i) => `• ${esc(i.title)}${i.owner ? ` — <b>${esc(i.owner)}</b>` : ""}`).join("\n")}` : "",
        late.length ? `Просрочено:\n${late.map((i) => `• ${esc(i.title)} (до ${i.due})`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const nt = await import("@/lib/notify/telegram");
      await nt.sendToTeam(html).catch(() => {});
      await nt.sendToOwners(o.clientId, html).catch(() => {});
    }
  }
  return n;
}

const daysLate = (due: string, today: string) => Math.round((Date.parse(today) - Date.parse(due)) / 86400_000);

/** Адаптация собеседника (по @нику, телефону или почте разговора). */
async function onboardingFor(ctx: ToolContext & { clientId: string }) {
  if (!ctx.conversationId) return null;
  const [c] = await db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
  if (!c) return null;
  const list = await db.select().from(onboardings).where(and(eq(onboardings.clientId, ctx.clientId), eq(onboardings.status, "active")));
  const handle = c.contactHandle.replace(/^@/, "").toLowerCase();
  const ext = c.externalId.toLowerCase();
  return (
    list.find((o) => {
      const k = keysOf(o);
      return (k.telegram && k.telegram.replace(/^@/, "").toLowerCase() === handle) || (k.phone.length >= 9 && ext.replace(/\D/g, "").endsWith(k.phone.slice(-9))) || (k.email && k.email === ext);
    }) ?? null
  );
}

export async function hasActiveOnboardings(clientId: string) {
  const [x] = await db.select({ id: onboardings.id }).from(onboardings).where(and(eq(onboardings.clientId, clientId), eq(onboardings.status, "active"))).limit(1);
  return Boolean(x);
}

export const onboardingNote =
  "# Адаптация новых сотрудников\nЕсли собеседник — новый сотрудник на адаптации, его план смотри инструментом onboarding_checklist; когда он говорит, что сделал пункт, — отметь onboarding_mark_done. Не отмечай без его слов.";

export function onboardingTools(ctx: ToolContext & { clientId: string }): AgentTool[] {
  const list = (o: Onboarding) => o.items.map((i) => `[${i.id}] ${i.done ? "✅" : "⬜"} ${i.due} ${i.title}${i.owner ? ` (${i.owner})` : ""}`).join("\n");
  return [
    {
      name: "onboarding_checklist",
      description: "Onboarding checklist of the current employee (new hire): items with due dates and done marks. Use when they ask what to do next or about their plan.",
      inputSchema: { type: "object", properties: {} },
      parse: z.object({}).passthrough(),
      run: async () => {
        if (ctx.mode !== "live") return "[Test mode: 0 ⬜ 2026-11-02 Получить доступы; 1 ⬜ 2026-11-02 Знакомство с командой]";
        const o = await onboardingFor(ctx);
        if (!o) return "This person has no onboarding plan.";
        return `Onboarding of ${o.name} (${o.role || "—"}), start ${o.startDate}:\n${list(o)}`;
      },
    },
    {
      name: "onboarding_mark_done",
      description: "Mark an onboarding item as done when the employee says they completed it. Pass the item id from onboarding_checklist.",
      inputSchema: { type: "object", properties: { item_id: { type: "string" } }, required: ["item_id"] },
      parse: z.object({ item_id: z.string().trim().min(1).max(20) }),
      run: async (input) => {
        if (ctx.mode !== "live") return "[Test mode: item marked as done]";
        const o = await onboardingFor(ctx);
        if (!o) return "This person has no onboarding plan.";
        const id = (input as { item_id: string }).item_id.replace(/[[\]]/g, "");
        if (!o.items.some((i) => i.id === id)) return `Unknown item. Items:\n${list(o)}`;
        const row = await markItem(o.id, id, true);
        const left = row?.items.filter((i) => !i.done).length ?? 0;
        return left ? `Marked. Items left: ${left}.` : "Marked. All onboarding items are done — congratulate them.";
      },
    },
  ];
}
