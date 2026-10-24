import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { clients, conversations, messages } from "@/db/schema";
import { streamChat } from "@/lib/llm";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";

/**
 * Бриф перед звонком: на одну страницу — кто клиент, что ищет и что ему уже сказали, свежие новости его компании
 * (если она известна и включён поиск в интернете), какие возражения ждать, о чём говорить и какой шаг предложить.
 * Менеджер готовится за полминуты, а не перечитывает переписку.
 */
const MODEL = "anthropic:claude-sonnet-5-5";

export async function callBrief(conversationId: string): Promise<string | null> {
  return withKeys({ conversationId }, async () => {
    if (!apiKey("anthropic")) return null;
    const [row] = await db
      .select({ c: conversations, client: clients })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(eq(conversations.id, conversationId));
    if (!row) return null;
    const history = await db
      .select({ role: messages.role, text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "sent"), inArray(messages.role, ["user", "assistant", "operator"])))
      .orderBy(asc(messages.createdAt))
      .limit(400);
    const dialog = history
      .slice(-80)
      .map((m) => `${m.role === "user" ? "Клиент" : m.role === "operator" ? "Менеджер" : "Консультант"}: ${m.text.slice(0, 600)}`)
      .join("\n");
    const ctx = row.c.context;
    const lead = ctx?.lead;
    const leadText = lead ? `${lead.temperature}${lead.reason ? ` — ${lead.reason}` : ""}; ${lead.fields.map((f) => `${f.label}: ${f.value}`).join("; ")}` : "";
    const company = lead?.fields.find((f) => /компан|организац|бизнес|company/i.test(f.label))?.value ?? "";
    const { getServices } = await import("@/lib/services");
    const search = company && (await getServices()).webSearch.enabled;
    let text = "";
    const started = Date.now();
    for await (const ev of streamChat({
      model: MODEL,
      effort: "low",
      system: [
        `Ты готовишь менеджеру компании «${row.client.name}» короткий бриф перед звонком клиенту. Максимум одна страница, по-русски, разделы с заголовками «## …»:`,
        "## Кто клиент — имя, канал, что ищет, бюджет и сроки, насколько «горячий».",
        "## Что уже обсудили — 3–5 пунктов: что спрашивал, что ему ответили и пообещали.",
        search ? "## Компания клиента — 1–3 свежих факта из интернета (найди поиском), с источником; ничего не нашлось — так и напиши." : "",
        "## Каких возражений ждать — 2–3, и как ответить на каждое одной фразой.",
        "## О чём говорить — цель звонка и конкретный следующий шаг, который предложить.",
        "Только факты из переписки и карточки (и найденного поиском). Не выдумывай. Без воды.",
      ]
        .filter(Boolean)
        .join("\n"),
      messages: [
        {
          role: "user",
          content: [
            `Клиент: ${row.c.contactName || row.c.contactHandle || "—"} (${row.c.channelType})`,
            leadText ? `Карточка лида: ${leadText}` : "",
            ctx?.memory?.facts?.length ? `Что известно о клиенте: ${ctx.memory.facts.join("; ")}` : "",
            company ? `Компания клиента: ${company}` : "",
            `Переписка:\n${dialog || "(пусто)"}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      webSearch: search ? { maxUses: 2 } : undefined,
    })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done") await logUsage({ source: "insights", model: ev.servedBy, usage: ev.usage, clientId: row.c.clientId, conversationId, ms: Date.now() - started }).catch(() => {});
    }
    return text.trim() || null;
  });
}
