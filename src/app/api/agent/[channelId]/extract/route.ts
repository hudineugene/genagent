import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { apiChannel } from "@/lib/channels/api-auth";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";

/**
 * Свой бот просит достать из разговора клиента с агентом нужные ему поля — например, заполнить бриф
 * (тип стикеров, количество, герой) или карточку лида (бюджет, цель, сроки). Только то, что клиент
 * действительно сказал; неизвестное — null. Дешёвая модель, без ответа клиенту.
 */
const MODEL = "claude-haiku-5-5";
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  user: z.object({ id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(100)) }),
  fields: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
        description: z.string().trim().min(2).max(300),
        options: z.array(z.string().max(60)).max(20).optional(),
      }),
    )
    .min(1)
    .max(12),
});

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await apiChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request", details: parsed.error.issues[0]?.message }, { status: 400 });
  const { user, fields } = parsed.data;
  const empty = Object.fromEntries(fields.map((f) => [f.key, null]));

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.channelId, channel.id), eq(conversations.externalId, user.id)))
    .limit(1);
  if (!conversation) return Response.json({ values: empty, found: 0 });
  const rows = await db
    .select({ role: messages.role, text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.status, "sent"), gt(messages.createdAt, new Date(Date.now() - WINDOW_MS))))
    .orderBy(asc(messages.createdAt));
  const dialog = rows.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "operator").slice(-40);
  if (!dialog.some((m) => m.role === "user")) return Response.json({ values: empty, found: 0 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ values: empty, found: 0, reason: "no_key" });

  const started = Date.now();
  const properties = Object.fromEntries(
    fields.map((f) => [f.key, { anyOf: [f.options?.length ? { type: "string", enum: f.options } : { type: "string" }, { type: "null" }] }]),
  );
  try {
    const { data, usage, model } = await generateJson<Record<string, string | null>>(key, MODEL, {
      system: [
        "Ты извлекаешь данные из переписки клиента с консультантом компании для заполнения формы.",
        "Заполняй поле только тем, что КЛИЕНТ сам сказал или явно подтвердил. Предложения консультанта, которые клиент не подтвердил, не считаются.",
        "Если клиент этого не говорил или неясно — null. Ничего не придумывай. Значения пиши кратко, на языке клиента.",
        "Для полей с вариантами выбирай только из вариантов (или null).",
      ].join("\n"),
      prompt: `Поля:\n${fields.map((f) => `- ${f.key}: ${f.description}${f.options?.length ? ` (варианты: ${f.options.join(", ")})` : ""}`).join("\n")}\n\nПереписка:\n${dialog
        .map((m) => `${m.role === "user" ? "Клиент" : "Консультант"}: ${m.text.slice(0, 1500)}`)
        .join("\n")}`,
      schema: { type: "object", additionalProperties: false, required: fields.map((f) => f.key), properties },
      effort: "low",
    });
    await logUsage({ source: "insights", model, usage, agentId: channel.agentId, clientId: channel.clientId, ms: Date.now() - started }).catch(() => {});
    const values = Object.fromEntries(
      fields.map((f) => {
        const v = typeof data[f.key] === "string" ? data[f.key]!.trim().slice(0, 500) : null;
        return [f.key, v && (!f.options?.length || f.options.includes(v)) ? v : null];
      }),
    );
    return Response.json({ values, found: Object.values(values).filter(Boolean).length });
  } catch (e) {
    console.error("extract failed", e);
    return Response.json({ values: empty, found: 0, reason: "error" });
  }
}
