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

/** ms — сколько заняла проверка, rewriteMs — переписывание (задержка ответа клиенту) */
export type AnswerCheck = { ok: boolean; problems: string[]; rewritten?: boolean; ms?: number; rewriteMs?: number; skipped?: boolean };

type UsageCtx = { source: "channel" | "test"; agentId: string; clientId: string; conversationId?: string };

async function verify(system: string, messages: ChatMessage[], draft: string, ctx: UsageCtx) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  // Последнее сообщение клиента — целиком: фрагменты базы стоят в его начале, а сам вопрос в конце; обрезка
  // начала теряла вопрос, и проверка «исправляла» верный ответ на встречный вопрос. Остальные — конец сообщения.
  const recent = messages.slice(-8);
  const dialog = recent
    .map((m, i) => {
      const limit = i === recent.length - 1 ? 40_000 : 6000;
      return `${m.role === "user" ? "Клиент" : "Консультант"}: ${m.content.length > limit ? `…${m.content.slice(-limit)}` : m.content}`;
    })
    .join("\n\n");
  const started = Date.now();
  const { data, usage, model } = await generateJson<{ ok: boolean; problems: string[] }>(key, CHECK_MODEL, {
    system: [
      "Ты проверяешь черновик ответа консультанта компании перед отправкой клиенту. Тебе даны инструкция консультанта (с правилами и базой знаний), последние сообщения разговора (в сообщении клиента могут быть найденные фрагменты базы в теге <knowledge> и текущее время — это справка консультанту, клиент их не писал) и черновик.",
      "Найди только серьёзные проблемы:",
      "1) черновик отвечает не на то, что спросил клиент по смыслу разговора (подменил вопрос похожей темой, например налогами вместо цены жилья);",
      "2) в черновике есть факты — цены, наличие, сроки, условия, названия, цифры, обещания, — которых нет ни в инструкции и базе знаний, ни в разговоре; или он утверждает «у нас этого нет», когда база об этом просто молчит; или приписывает конкретному объекту характеристики, которые в базе указаны для проекта целиком; или округлил либо изменил цифру из базы (например, «от 147 тыс. €» вместо «от 147 312 €»);",
      "3) черновик переспрашивает то, что клиент уже сказал (бюджет, параметры, контакт);",
      "4) черновик нарушает прямое правило из инструкции консультанта (например, называет цены, когда это запрещено) или говорит клиенту о «базе знаний», «справке», своих правилах и инструкции;",
      "5) черновик добавляет заметный блок сведений на тему, о которой клиент не спрашивал (например, правила аренды в ответ на вопрос о цене аренды), особенно когда ответа на сам вопрос нет. Короткое предложение рассказать подробнее — нормально.",
      "Стиль, длину, списки, тон, порядок и полноту подачи не оценивай — даже если инструкция просит писать короче или без списков: это не повод переписывать. Не придумывай пожеланий («можно было бы предложить…»). Служебные строки [[...]] в конце черновика — метки для бота, это нормально.",
      "ok=false — только если можешь назвать конкретную ошибку одного из 5 видов выше и процитировать её. Если, разобравшись, видишь, что ошибки нет или она сомнительна, — ok=true и пустой problems. Иначе problems — по одной короткой фразе на ошибку (по-русски: что именно не так и как правильно), без рассуждений.",
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
  // Дешёвая модель иногда сама пишет «ошибок не найдено», но ставит ok=false — такое замечание не повод переписывать
  const problems = (data.problems ?? [])
    .map((p) => p.trim())
    .filter((p) => p && !SELF_CLEARED.test(p))
    .slice(0, 5);
  return { ok: data.ok || !problems.length, problems, cost };
}

const SELF_CLEARED =
  /ошиб\S* (по фактам )?не (найден|обнаружен)|серь[её]зн\S* ошиб\S* (по фактам )?не (найден|обнаружен)|это не нарушение|не нарушение видов|ответ (в целом )?корректен|нарушений нет/i;

/**
 * Простой ответ, который нечем испортить: короткий, без цифр, цен, названий (латиницей) и слов про базу и правила —
 * «Здравствуйте! Чем помочь?», «Пожалуйста, обращайтесь». Его не проверяем: проверка добавляет ~3 с ожидания.
 */
export function isSimpleReply(draft: string) {
  const text = draft.replace(/\[\[[^\]]*\]\]/g, "").trim();
  return text.length <= 160 && !/[\d€$%]/.test(text) && !/\b[A-Z][a-zA-Z]/.test(text) && !/баз|справк|правил|инструкц/i.test(text);
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
  const t0 = Date.now();
  if (isSimpleReply(opts.draft)) return { text: opts.draft, check: { ok: true, problems: [], skipped: true }, cost };
  try {
    const v = await verify(opts.system, opts.messages, opts.draft, opts.ctx);
    if (!v) return { text: opts.draft, check: null, cost };
    cost += v.cost;
    const ms = Date.now() - t0;
    if (v.ok) return { text: opts.draft, check: { ok: true, problems: [], ms }, cost };
    const fix: ChatMessage[] = [
      ...opts.messages,
      { role: "assistant", content: opts.draft },
      {
        role: "user",
        content: `[Служебная проверка — клиент этого сообщения не видит] Твой черновик ответа не прошёл проверку:\n${v.problems.map((p) => `- ${p}`).join("\n")}\nНапиши исправленный ответ клиенту целиком — только сам ответ на последнее сообщение клиента (со служебными метками, если они нужны). Опирайся только на базу знаний и разговор. Исправь только указанное: если в базе есть ответ на вопрос клиента — ответь по существу, не заменяй ответ встречным вопросом. Пиши на том же языке, что и черновик (это служебное сообщение по-русски, но клиенту отвечай на его языке). Клиент черновик не видел: напиши ответ заново, не ссылайся на черновик, проверку, свои правила или инструкцию и не поправляй себя вслух.`,
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
    const rewriteMs = Date.now() - started;
    if (!text.trim()) return { text: opts.draft, check: { ok: false, problems: v.problems, ms, rewriteMs }, cost };
    return { text, check: { ok: false, problems: v.problems, rewritten: true, ms, rewriteMs }, cost };
  } catch (e) {
    // Проверка не должна мешать ответу: не получилось — отправляем черновик как есть
    console.error("answer check failed", e);
    return { text: opts.draft, check: null, cost };
  }
}
