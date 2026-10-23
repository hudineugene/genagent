/** Анализ данных: CSV и Excel читаются, типы столбцов определяются, запрос (фильтры, группировка, суммы)
 *  считается кодом; таблица передаётся агенту инструментом; «Аналитик» делает запрос и рисует график;
 *  отчёт по расписанию считает по таблице инструментом. Модель — макет.
 *  DB_PATH=<копия caltest> XLSX=<путь к sales.xlsx> npx tsx scripts/test-data.ts */
import fs from "node:fs";
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, dataTables, routines } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const results: string[] = [];
  /** Очередь вызовов инструментов, которые «модель» сделает по порядку, затем — текст */
  let calls: { name: string; input: object }[] = [];
  let finalText = "Готово";
  let lastSystem = "";
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const start = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      lastSystem = typeof b.system === "string" ? b.system : JSON.stringify(b.system);
      const last = b.messages.at(-1);
      const result = Array.isArray(last?.content) ? last.content.find((x: { type: string }) => x.type === "tool_result") : null;
      if (result) results.push(String(typeof result.content === "string" ? result.content : JSON.stringify(result.content)));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const call = calls.shift();
      if (!call) {
        return res.end(start + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: finalText } }) + ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) + ev("message_stop", {}));
      }
      res.end(
        start +
          ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `tu${calls.length}`, name: call.name, input: {} } }) +
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4056, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4056";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:9";

  const { parseCsv, buildTable, toNumber, runQuery, readDataFile, tableToolName } = await import("@/lib/data/tables");
  const csv = 'Объект;Город;Цена;Дата\n"Riviera 1";Финестрат;"96 092 €";01.09.2026\nSierra Verde;Полоп;250000;15.09.2026\n"Casa ""Sol""";Финестрат;180 000,50;02.10.2026\n\nRiviera 2;Бенидорм;€ 120,000;20.10.2026\n';
  const t1 = buildTable(parseCsv(csv));
  const nums = [toNumber("1 250,50 €"), toNumber("$1,250.50"), toNumber("12%"), toNumber("-3.5"), toNumber("Riviera 1"), toNumber("1.250.000"), toNumber("abc")];
  const q1 = runQuery(t1, { filters: [{ column: "город", op: "=", value: "финестрат" }], metrics: [{ fn: "sum", column: "Цена" }, { fn: "count" }] });
  const q2 = runQuery(t1, { groupBy: ["Город"], metrics: [{ fn: "avg", column: "Цена" }], sort: { by: "avg(Цена)", desc: true } });
  const q3 = runQuery(t1, { filters: [{ column: "Дата", op: ">=", value: "2026-10-01" }], columns: ["Объект"], sort: { by: "Объект" } });
  let unknown = "";
  try {
    runQuery(t1, { filters: [{ column: "Площадь", op: ">", value: 1 }] });
  } catch (e) {
    unknown = e instanceof Error ? e.message : "";
  }
  const xlsx = readDataFile(fs.readFileSync(process.env.XLSX ?? ""), "sales.xlsx", "Продажи");
  const t2 = buildTable(xlsx);

  // Таблица в базе → агент, «Аналитик», отчёт
  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const [row] = await db
    .insert(dataTables)
    .values({ clientId: client.id, name: "Продажи", description: "одна строка — продажа", columns: t2.columns, rows: t2.rows, rowCount: t2.rows.length, refreshedAt: new Date() })
    .returning();
  const tool = tableToolName(row);

  const { prepareChat } = await import("@/lib/agent/runtime");
  const { streamChat } = await import("@/lib/llm");
  const base = agentConfigSchema.parse(agent.config);
  const config = { ...base, tableIds: [row.id], calendar: { ...base.calendar, enabled: false } };
  calls = [{ name: tool, input: { groupBy: ["Менеджер"], metrics: [{ fn: "sum", column: "Сумма" }], sort: { by: "sum(Сумма)", desc: true } } }];
  const p = await prepareChat(config, client, [{ role: "user", content: "Кто продал больше?" }], { mode: "dry", agentId: agent.id });
  for await (const e of streamChat({ model: "anthropic:claude-haiku-5-5", effort: "low", system: p.system, messages: p.messages, tools: p.tools })) void e;
  const agentResult = results.at(-1) ?? "";

  const { askData } = await import("@/lib/data/analyst");
  calls = [
    { name: tool, input: { groupBy: ["Менеджер"], metrics: [{ fn: "sum", column: "Сумма" }] } },
    { name: "show_chart", input: { type: "bar", title: "Продажи по менеджерам", labels: ["Анна", "Борис"], series: [{ name: "Сумма", values: [1500, 1800.5] }] } },
    { name: "show_chart", input: { type: "bar", title: "Сломанный", labels: ["A", "B"], series: [{ name: "x", values: [1] }] } },
  ];
  finalText = "Больше продал Борис: 1 800,5.";
  const asked = await askData(client.id, "Кто продал больше? Покажи график");

  const { runRoutine } = await import("@/lib/routines/engine");
  const [routine] = await db
    .insert(routines)
    .values({ clientId: client.id, name: "Итоги", task: "Итоги продаж", schedule: { freq: "weekly", hour: 9, weekday: 1 }, sources: [{ type: "table", tableId: row.id }], delivery: { team: false, owners: false }, enabled: false })
    .returning();
  calls = [{ name: tool, input: { metrics: [{ fn: "sum", column: "Сумма" }, { fn: "count" }] } }];
  finalText = "Итого 3 300,5";
  const routineRun = await runRoutine(routine.id, { send: false });
  const routineResult = results.at(-1) ?? "";
  const routineSystem = lastSystem;

  await db.delete(routines).where(eq(routines.id, routine.id));
  await db.delete(dataTables).where(eq(dataTables.id, row.id));
  stub.close();

  const result: Record<string, boolean> = {
    "CSV: разделитель, кавычки, пустая строка, типы": t1.rows.length === 4 && t1.rows[2][0] === 'Casa "Sol"' && t1.columns.map((c) => c.type).join(",") === "text,text,number,date",
    "числа: валюты, разделители, текст — не число":
      nums[0] === 1250.5 && nums[1] === 1250.5 && nums[2] === 12 && nums[3] === -3.5 && nums[4] === null && nums[5] === 1250000 && nums[6] === null,
    "запрос: фильтр без учёта регистра, сумма и количество": q1.rows[0][0] === 276092.5 && q1.rows[0][1] === 2 && q1.matched === 2,
    "запрос: группировка, среднее, сортировка": q2.rows[0][0] === "Полоп" && q2.rows[0][1] === 250000 && q2.rows.length === 3,
    "запрос: фильтр по дате и список": q3.rows.map((r) => r[0]).join(",") === 'Casa "Sol",Riviera 2',
    "неизвестный столбец — понятная ошибка со списком": unknown.includes("Площадь") && unknown.includes("Объект"),
    "Excel: нужный лист, общие строки, даты": t2.columns.map((c) => `${c.name}:${c.type}`).join(",") === "Дата:date,Менеджер:text,Сумма:number" && t2.rows[0][0] === "01.09.2026" && t2.rows[1][1] === "Борис" && t2.rows[3][1] === "Tom & Co" && t2.rows[2][0] === "02.10.2026",
    "агенту — инструмент и подсказка": Boolean(p.tools?.some((x) => x.name === tool)) && p.system.includes("# Таблицы данных") && p.system.includes("«Продажи»"),
    "агенту — точный результат запроса": agentResult.includes("Анна | 1500") && agentResult.includes("Борис | 800.5") && agentResult.indexOf("Анна") < agentResult.indexOf("Tom & Co | 1000") && agentResult.indexOf("Tom & Co") < agentResult.indexOf("Борис"),
    "Аналитик: ответ, график, неверный график отклонён": asked.answer.includes("Борис") && asked.charts.length === 1 && asked.charts[0].title === "Продажи по менеджерам" && asked.queries === 1 && Boolean(results.find((r) => r.includes("one value per label"))),
    "отчёт: таблица в данных, расчёт инструментом": routineRun.ok && routineRun.text.includes("3 300,5") && routineResult.includes("3300.5 | 4") && routineSystem.includes("инструментами table_"),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
