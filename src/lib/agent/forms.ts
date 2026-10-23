import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clientForms, formResponses, type ClientForm, type FormField } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import type { ToolContext } from "./tools";

/**
 * Анкеты и тесты: для каждой анкеты агента — инструмент со своими полями. Агент задаёт вопросы разговором
 * (по одному-два), а когда собрал ответы — вызывает инструмент. Ответы сохраняются (в тест-чате и автотестах — нет),
 * у теста считаются баллы; заполненная анкета — менеджеру в Telegram и во внешние системы клиента.
 */

/** Имя инструмента анкеты для модели */
export const formToolName = (f: Pick<ClientForm, "id">) => `form_${f.id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Баллы теста: ответ совпал с правильным (без учёта регистра и знаков; для текста — содержит правильный). */
export function scoreAnswers(fields: FormField[], answers: Record<string, string>) {
  const graded = fields.filter((f) => f.correct?.trim());
  if (!graded.length) return null;
  let score = 0;
  let max = 0;
  const wrong: { label: string; correct: string }[] = [];
  for (const f of graded) {
    const pts = f.points ?? 1;
    max += pts;
    const a = norm(answers[f.key] ?? "");
    const c = norm(f.correct ?? "");
    const ok = a && (f.type === "text" ? a.includes(c) : a === c);
    if (ok) score += pts;
    else wrong.push({ label: f.label, correct: f.correct ?? "" });
  }
  return { score, max, wrong };
}

function fieldSchema(f: FormField) {
  const desc = `${f.label}${f.options?.length ? ` (варианты: ${f.options.join(" / ")})` : ""}${f.type === "rating" ? " (оценка 1–10)" : ""}`;
  if (f.type === "number" || f.type === "rating") return { json: { type: "number", description: desc }, zod: z.number() };
  if (f.type === "choice" && f.options?.length) return { json: { type: "string", enum: f.options, description: desc }, zod: z.string().max(500) };
  return { json: { type: "string", description: desc }, zod: z.string().max(2000) };
}

export function formTool(form: ClientForm, ctx: ToolContext): AgentTool {
  const props = Object.fromEntries(form.fields.map((f) => [f.key, fieldSchema(f).json]));
  const shape = Object.fromEntries(form.fields.map((f) => [f.key, f.required ? fieldSchema(f).zod : fieldSchema(f).zod.optional()]));
  const kind = form.kind === "quiz" ? "Test/quiz" : "Form";
  return {
    name: formToolName(form),
    description: [
      `${kind} «${form.name}». When to use: ${form.purpose || "when it fits the conversation"}.`,
      "Ask the customer these questions in a natural conversation, one or two at a time, in their language; do not show this list as a form. Call this tool once, when you have all required answers (and any optional ones the customer gave).",
      form.kind === "quiz" ? "Do not reveal the correct answers before the tool returns the result." : "",
    ]
      .filter(Boolean)
      .join(" "),
    inputSchema: { type: "object", properties: props, required: form.fields.filter((f) => f.required).map((f) => f.key) },
    parse: z.object(shape).passthrough(),
    run: async (input) => {
      const answers = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
      const graded = form.kind === "quiz" ? scoreAnswers(form.fields, answers) : null;
      if (ctx.mode === "live") await saveResponse(form, ctx, answers, graded);
      const parts = [ctx.mode === "live" ? "Saved." : "[Test mode: not saved.]"];
      if (graded) {
        parts.push(`Score: ${graded.score} of ${graded.max}.`);
        if (graded.wrong.length) parts.push(`Wrong: ${graded.wrong.map((w) => `${w.label} — correct: ${w.correct}`).join("; ")}.`);
        parts.push("Tell the customer the result briefly and kindly; explain the mistakes.");
      }
      if (form.thanks.trim()) parts.push(`Then say (in the customer's language): ${form.thanks.trim()}`);
      return parts.join(" ");
    },
  };
}

async function saveResponse(form: ClientForm, ctx: ToolContext, answers: Record<string, string>, graded: { score: number; max: number } | null) {
  await db.insert(formResponses).values({
    formId: form.id,
    clientId: form.clientId,
    agentId: ctx.agentId ?? null,
    conversationId: ctx.conversationId ?? null,
    answers,
    score: graded?.score ?? null,
    maxScore: graded?.max ?? null,
  });
  // Подписи вместо ключей — для людей и внешних систем
  const labeled = Object.fromEntries(form.fields.filter((f) => answers[f.key] !== undefined).map((f) => [f.label, answers[f.key]]));
  const payload = { id: form.id, name: form.name, answers: labeled, score: graded?.score ?? null, maxScore: graded?.max ?? null };
  void import("@/lib/integrations/events").then((m) =>
    m.emitEvent("form", { clientId: form.clientId, agentId: ctx.agentId, conversationId: ctx.conversationId, form: payload }),
  );
  if (form.notify) void import("@/lib/notify/telegram").then((n) => n.notifyForm(ctx.conversationId ?? null, form.clientId, payload));
}

/** Анкеты агента (включённые). */
export async function loadForms(clientId: string, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select()
    .from(clientForms)
    .where(and(eq(clientForms.clientId, clientId), inArray(clientForms.id, ids), eq(clientForms.enabled, true)));
}

/** Подсказка агенту: какие анкеты есть и когда их предлагать. */
export function formsNote(forms: ClientForm[]) {
  if (!forms.length) return "";
  return [
    "# Анкеты и тесты",
    "У тебя есть анкеты (инструменты form_…). Когда разговор подходит под назначение анкеты — предложи её клиенту и проведи по вопросам обычным разговором, по одному-два за раз. Не задавай вопросы, на которые клиент уже ответил в разговоре, — используй его ответы. Когда собрал ответы — вызови инструмент.",
    ...forms.map((f) => `• «${f.name}» (${formToolName(f)}): ${f.purpose || "—"}`),
  ].join("\n");
}
