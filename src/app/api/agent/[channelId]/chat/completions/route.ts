import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, clients, conversations, messages } from "@/db/schema";
import { voiceChannel } from "@/lib/channels/api-auth";
import { addMessage, flag, toPlainText, upsertConversation } from "@/lib/conversations";
import { agentConfigSchema } from "@/lib/agent/types";
import { extractHandoff, prepareChat } from "@/lib/agent/runtime";
import { streamChat, type ChatMessage } from "@/lib/llm";
import { findModel } from "@/lib/models";
import { agentMonthSpend, logUsage } from "@/lib/usage";
import { withKeys } from "@/lib/keys";

/**
 * «Своя модель» для голосовых платформ (Vapi, ElevenLabs): POST {база}/chat/completions в формате OpenAI с ключом
 * голосового канала. История звонка приходит от платформы (её системные сообщения не используем — инструкции
 * агента свои), ответ — потоком chat.completion.chunk или одним chat.completion. Звонок — разговор во «Входящих»;
 * агент решил передать менеджеру — разговор помечается, команде уведомление.
 */
const VOICE_NOTE = [
  "# Канал: телефонный звонок",
  "Твой ответ озвучивается голосом. Говори 1–3 короткими фразами, как живой администратор по телефону. Без списков, markdown, ссылок, эмодзи и смайлов.",
  "Цены, даты, время и номера произноси словами так, как их говорят вслух. Длинные адреса, ссылки и реквизиты не диктуй — предложи прислать в мессенджер или на почту.",
  "Если не расслышал или не понял — коротко переспроси.",
].join("\n");

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()), z.null()]).optional() }).passthrough()).min(1).max(200),
  stream: z.boolean().optional(),
  model: z.string().optional(),
  call: z.object({ id: z.string().optional(), customer: z.object({ number: z.string().optional(), name: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  user: z.string().optional(),
  user_id: z.string().optional(),
});

const HISTORY_CHARS = 40_000;
const OVER_LIMIT = "Сейчас не могу ответить. Передам ваш вопрос менеджеру — вам перезвонят.";

const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "");

export async function POST(req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  const channel = await voiceChannel(channelId, req.headers.get("authorization"));
  if (!channel) return Response.json({ error: { message: "invalid_key", type: "invalid_request_error" } }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: { message: "bad_request", type: "invalid_request_error" } }, { status: 400 });
  const body = parsed.data;
  const [row] = await db.select({ agent: agents, client: clients }).from(agents).innerJoin(clients, eq(clients.id, agents.clientId)).where(eq(agents.id, channel.agentId));
  if (!row || row.agent.status !== "active" || !channel.enabled) return Response.json({ error: { message: "agent_inactive", type: "server_error" } }, { status: 503 });
  const { agent, client } = row;
  const config = agentConfigSchema.parse(agent.config);

  // История звонка от платформы: только реплики собеседников; каждая до 4000 знаков, в модель — последние 40 000 знаков
  const all: ChatMessage[] = body.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: text(m.content).slice(0, 4000) }))
    .filter((m) => m.content.trim());
  let budget = HISTORY_CHARS;
  let from = all.length;
  while (from > 0 && budget - all[from - 1].content.length >= 0) budget -= all[--from].content.length;
  const history = all.slice(from);
  if (!history.some((m) => m.role === "user")) history.push({ role: "user", content: "(клиент молчит)" });

  // Звонок — разговор: id звонка (Vapi call.id, ElevenLabs — conversation_id в metadata или user_id);
  // без id — номер и день, чтобы реплики одного звонка не расходились по разным разговорам
  const callId = body.call?.id ?? String(body.metadata?.call_id ?? body.metadata?.conversation_id ?? body.user_id ?? body.user ?? "");
  const phone = body.call?.customer?.number ?? "";
  const key = callId ? `call:${callId}` : `call:${phone || "unknown"}:${new Date().toISOString().slice(0, 10)}`;
  const { conversation } = await upsertConversation(channel, key, { name: body.call?.customer?.name ?? phone, handle: phone });
  // Платформа присылает всю историю звонка: записываем только новые реплики клиента (повтор запроса — без дублей)
  const said = all.filter((m) => m.role === "user");
  const [{ n: stored }] = await db.select({ n: sql<number>`count(*)` }).from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "user")));
  for (const m of said.slice(Number(stored))) await addMessage(conversation.id, "user", m.content, { meta: { kind: "voice" } });

  const started = Date.now();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(started / 1000);
  const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: config.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  // Месячные лимиты, как в чате: агента и клиента (биллинг студии). В звонке не молчим — обещаем перезвонить.
  const over =
    config.monthlyBudgetUsd != null && (await agentMonthSpend(agent.id)) >= config.monthlyBudgetUsd
      ? "budget_exceeded"
      : (await import("@/lib/billing").then((b) => b.clientOverLimit(client.id)).catch(() => false))
        ? "client_limit"
        : null;

  const run = async (emit?: (s: string) => void) =>
    withKeys({ clientId: client.id }, async () => {
      if (over) {
        await flag(conversation.id, over);
        emit?.(chunk({ content: OVER_LIMIT }));
        return OVER_LIMIT;
      }
      const prepared = await prepareChat(config, client, history, { mode: "live", agentId: agent.id, conversationId: conversation.id }, VOICE_NOTE);
      let full = "";
      let sent = 0;
      for await (const ev of streamChat({ model: config.model, effort: config.effort, system: prepared.system, messages: prepared.messages, tools: prepared.tools })) {
        if (ev.type === "text") {
          full += ev.text;
          // Служебные метки [[…]] не озвучиваем: отдаём только текст до начала метки
          const cut = full.indexOf("[[");
          const visible = cut >= 0 ? full.slice(0, cut) : full;
          if (emit && visible.length > sent) {
            emit(chunk({ content: visible.slice(sent).replace(/\*\*|__|#+ /g, "") }));
            sent = visible.length;
          }
        } else if (ev.type === "done") {
          const ms = Date.now() - started;
          await logUsage({ source: "channel", model: findModel(ev.servedBy) ? ev.servedBy : config.model, usage: ev.usage, agentId: agent.id, clientId: client.id, conversationId: conversation.id, ms });
        }
      }
      const { text: clean, handoff, actions } = extractHandoff(full);
      const reply = toPlainText(clean);
      // Текст после служебной метки (если был) — дослать
      if (emit && reply.length > sent) emit(chunk({ content: reply.slice(sent) }));
      await addMessage(conversation.id, "assistant", reply, { meta: { spoken: true, ms: Date.now() - started, ...(actions.length ? { actions } : {}) } });
      if (handoff) {
        await db.update(conversations).set({ needsAttention: true }).where(eq(conversations.id, conversation.id));
        void import("@/lib/notify/telegram").then((n) => n.notifyHandoff(conversation.id, `Звонок${phone ? ` с ${phone}` : ""}: клиенту нужен менеджер — перезвоните.`, { reason: "voice" }));
      }
      return reply;
    });

  if (body.stream) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (s: string) => controller.enqueue(enc.encode(s));
        emit(chunk({ role: "assistant", content: "" }));
        try {
          await run(emit);
        } catch (e) {
          console.error("voice completion failed", e);
          emit(chunk({ content: "Извините, у меня заминка. Передам ваш вопрос менеджеру — вам перезвонят." }));
        }
        emit(chunk({}, "stop"));
        emit("data: [DONE]\n\n");
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  }
  try {
    const reply = await run();
    return Response.json({ id, object: "chat.completion", created, model: config.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] });
  } catch (e) {
    console.error("voice completion failed", e);
    return Response.json({ error: { message: "agent_failed", type: "server_error" } }, { status: 500 });
  }
}
