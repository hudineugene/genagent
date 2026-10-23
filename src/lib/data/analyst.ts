import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clients, dataTables } from "@/db/schema";
import { streamChat, type AgentTool, type ChatMessage } from "@/lib/llm";
import { logUsage } from "@/lib/usage";
import { tableTool } from "./tables";

/**
 * «Аналитик»: владелец или сотрудник студии задаёт вопрос по таблицам клиента — модель строит точные запросы
 * (числа считает код), пишет вывод и при необходимости рисует график. Sonnet: запросы бывают многошаговыми.
 */
const MODEL = "anthropic:claude-sonnet-5-5";

export type ChartSpec = { type: "bar" | "line"; title: string; labels: string[]; series: { name: string; values: number[] }[] };

const chartSchema = z.object({
  type: z.enum(["bar", "line"]),
  title: z.string().max(200),
  labels: z.array(z.string().max(80)).min(1).max(60),
  series: z.array(z.object({ name: z.string().max(80), values: z.array(z.number()).max(60) })).min(1).max(4),
});

function chartTool(out: ChartSpec[]): AgentTool {
  return {
    name: "show_chart",
    description:
      "Show a chart to the user under your answer. Use only numbers returned by table tools. bar — compare categories, line — change over time (labels in time order). Up to 4 series, values aligned with labels.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar", "line"] },
        title: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"] } },
      },
      required: ["type", "title", "labels", "series"],
    },
    parse: chartSchema,
    run: async (input) => {
      const c = input as ChartSpec;
      if (c.series.some((s) => s.values.length !== c.labels.length)) return "Error: every series must have one value per label.";
      if (out.length >= 3) return "Error: at most 3 charts per answer.";
      out.push(c);
      return "Chart shown.";
    },
  };
}

export async function askData(clientId: string, question: string, history: ChatMessage[] = [], tableIds?: string[]) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { answer: "", charts: [], queries: 0, error: "no_key" as const };
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
  let tables = await db.select().from(dataTables).where(and(eq(dataTables.clientId, clientId), eq(dataTables.enabled, true)));
  if (tableIds?.length) tables = tables.filter((t) => tableIds.includes(t.id));
  if (!tables.length) return { answer: "", charts: [], queries: 0, error: "no_tables" as const };
  const charts: ChartSpec[] = [];
  let queries = 0;
  const tools = [...tables.map((t) => tableTool(t, () => queries++)), chartTool(charts)];
  const today = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Kyiv", dateStyle: "long" }).format(new Date());
  let answer = "";
  const started = Date.now();
  for await (const ev of streamChat({
    model: MODEL,
    effort: "medium",
    system: [
      `Ты аналитик данных компании «${client?.name ?? ""}». Сегодня ${today}. Отвечай на вопросы по таблицам компании.`,
      "Любые числа получай только инструментами table_… (фильтры, группировки, суммы, средние) — никогда не считай в уме и не выдумывай. Если вопрос неоднозначен — выбери разумное толкование и скажи, как понял.",
      "Ответ: сначала прямой ответ одним-двумя предложениями с цифрами, затем, если полезно, короткие пункты и вывод, что из этого следует. Без воды. Язык ответа — язык вопроса.",
      "Если сравнение или динамику нагляднее показать графиком — вызови show_chart с числами из результатов запросов.",
    ].join("\n"),
    messages: [...history.slice(-8), { role: "user", content: question }],
    tools,
  })) {
    if (ev.type === "text") answer += ev.text;
    else if (ev.type === "done") await logUsage({ source: "insights", model: ev.servedBy, usage: ev.usage, clientId, ms: Date.now() - started }).catch(() => {});
  }
  return { answer: answer.trim(), charts, queries };
}
