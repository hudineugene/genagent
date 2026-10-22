import "server-only";
import { generateJson } from "@/lib/llm/anthropic";
import { streamChat } from "@/lib/llm";
import type { ChatMessage } from "@/lib/llm/types";
import { findModel } from "@/lib/models";
import { logUsage } from "@/lib/usage";
import type { AgentConfig } from "@/lib/agent/types";

/**
 * Проверка ответа перед отправкой: вторая (дешёвая) модель смотрит черновик агента — отвечает ли он на суть вопроса,
 * нет ли фактов не из базы знаний и переписки, не переспрашивает ли уже сказанное, не нарушает ли правила агента.
 * Нашлась проблема — агент один раз переписывает ответ с учётом замечаний. Включается в настройках агента.
 */
const CHECK_MODEL = "claude-haiku-5-5";
const MAX_CONTEXT = 60_000;

export type AnswerCheck = { ok: boolean; problems: string[]; rewritten?: boolean };

type UsageCtx = { source: "channel" | "test"; agentId: string; clientId: string; conversationId?: string };

async function verify(system: string, messages: ChatMessage[], draft: string, ctx: UsageCtx) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const dialog = messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "Клиент" : "Консультант"}: ${m.content.slice(0, 6000)}`)
    .join("\n\n");
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ ok: boolean; problems: string[] }>(key, CHECK_MODEL, {
    system: [
      "Ты проверяешь черновик ответа консультанта компании перед отправкой клиенту. Тебе даны инструкция консультанта (с правилами и базой знаний), последние сообщения разговора (в сообщении клиента могут быть найденные фрагменты базы в теге <knowledge> и текущее время — это справка консультанту, клиент их не писал) и черновик.",
      "Найди только серьёзные проблемы:",
      "1) черновик отвечает не на то, что спросил клиент по смыслу разговора (подменил вопрос похожей темой, например налогами вместо цены жилья);",
      "2) в черновике есть факты — цены, наличие, сроки, условия, названия, цифры, обещания, — которых нет ни в инструкции и базе знаний, ни в разговоре; или он утверждает «у нас этого нет», когда база об этом просто молчит;",
      "3) черновик переспрашивает то, что клиент уже сказал (бюджет, параметры, контакт);",
      "4) черновик нарушает прямое правило из инструкции консультанта (например, называет цены, когда это запрещено).",
      "Стиль, длину, тон и мелочи не оценивай. Служебные строки [[...]] в конце черновика — метки для бота, это нормально.",
      "ok=true, если серьёзных проблем нет. Иначе ok=false и problems — по одной короткой фразе на проблему (по-русски, что именно не так и как правильно).",
    ].join("\n"),
    prompt: `Инструкция консультанта:\n${system.slice(0, MAX_CONTEXT)}\n\nРазговор:\n${dialog}\n\nЧерновик ответа консультанта:\n${draft}`,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "problems"],
      properties: { ok: { type: "boolean" }, problems: { type: "array", items: { type: "string" } } },
    },
    effort: "low",
  });
  const cost = (await logUsage({ source: ctx.source, model, usage, agentId: ctx.agentId, clientId: ctx.clientId, conversationId: ctx.conversationId, ms: Date.now() - started }).catch(() => null)) ?? 0;
  const problems = (data.problems ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 5);
  return { ok: data.ok || !problems.length, problems, cost };
}

/**
 * Проверить черновик и при необходимости один раз переписать. Возвращает итоговый текст (со служебными метками,
 * как у модели), результат проверки и стоимость проверки с переписыванием.
 */
export async function checkAndFix(opts: {
  config: Pick<AgentConfig, "model" | "effort">;
  system: string;
  messages: ChatMessage[];
  draft: string;
  ctx: UsageCtx;
}): Promise<{ text: string; check: AnswerCheck | null; cost: number }> {
  let cost = 0;
  try {
    const v = await verify(opts.system, opts.messages, opts.draft, opts.ctx);
    if (!v) return { text: opts.draft, check: null, cost };
    cost += v.cost;
    if (v.ok) return { text: opts.draft, check: { ok: true, problems: [] }, cost };
    const fix: ChatMessage[] = [
      ...opts.messages,
      { role: "assistant", content: opts.draft },
      {
        role: "user",
        content: `[Служебная проверка — клиент этого сообщения не видит] Твой черновик ответа не прошёл проверку:\n${v.problems.map((p) => `- ${p}`).join("\n")}\nНапиши исправленный ответ клиенту целиком — только сам ответ на последнее сообщение клиента (со служебными метками, если они нужны). Опирайся только на базу знаний и разговор.`,
      },
    ];
    let text = "";
    const started = Date.now();
    for await (const ev of streamChat({ model: opts.config.model, effort: opts.config.effort, system: opts.system, messages: fix })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done") {
        cost +=
          (await logUsage({
            source: opts.ctx.source,
            model: findModel(ev.servedBy) ? ev.servedBy : opts.config.model,
            usage: ev.usage,
            agentId: opts.ctx.agentId,
            clientId: opts.ctx.clientId,
            conversationId: opts.ctx.conversationId,
            ms: Date.now() - started,
          }).catch(() => null)) ?? 0;
      }
    }
    if (!text.trim()) return { text: opts.draft, check: { ok: false, problems: v.problems }, cost };
    return { text, check: { ok: false, problems: v.problems, rewritten: true }, cost };
  } catch (e) {
    // Проверка не должна мешать ответу: не получилось — отправляем черновик как есть
    console.error("answer check failed", e);
    return { text: opts.draft, check: null, cost };
  }
}
