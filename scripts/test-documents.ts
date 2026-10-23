/** Документы: файл клиента читается и прикрепляется к сообщению, дешёвая модель определяет тип и достаёт поля
 *  (сохраняются, менеджеру — в Telegram); шаблон документа передаётся агенту, в живом режиме документ выдаётся
 *  по ссылке с номером, датой и именем клиента, в тестовом — нет. Модель и Telegram — макеты.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-documents.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientDocTypes, clientDocuments, clients, conversations, docTemplates, generatedDocs, messages, settings } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const tg: string[] = [];
  const results: string[] = [];
  let call: { name: string; input: object } | null = null;
  let classifyPrompt = "";
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const start = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
  const textReply = (text: string) =>
    start + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) + ev("content_block_stop", { index: 0 }) + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) + ev("message_stop", {});
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/bot")) {
        if (req.url.endsWith("/sendMessage")) tg.push(JSON.parse(body).text);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, result: req.url.endsWith("/getUpdates") ? [] : { message_id: 1 } }));
      }
      const b = JSON.parse(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Разбор документа: структурированный ответ (лишнее поле extra должно отброситься)
      if (b.output_config?.format) {
        classifyPrompt = `${b.system}\n${b.messages[0].content}`;
        const data = { type: "t0", fields: [{ key: "supplier", value: "ООО Ромашка" }, { key: "amount", value: "1 250 €" }, { key: "extra", value: "x" }], summary: "Счёт за материалы на 1 250 €." };
        return res.end(textReply(JSON.stringify(data)));
      }
      const last = b.messages.at(-1);
      const result = Array.isArray(last?.content) ? last.content.find((x: { type: string }) => x.type === "tool_result") : null;
      if (result || !call) {
        if (result) results.push(String(result.content));
        return res.end(textReply("Готово!"));
      }
      res.end(
        start +
          ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu", name: call.name, input: {} } }) +
          ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4055, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4055";
  process.env.ANTHROPIC_API_KEY = "stub";
  process.env.TELEGRAM_API_URL = "http://127.0.0.1:4055";
  const notify = await getSetting("notify");
  await setSetting("notify", { token: "stub", subscribers: [{ chatId: "1" }] });

  const [agent] = await db.select().from(agents).limit(1);
  const [client] = await db.select().from(clients).where(eq(clients.id, agent.clientId));
  const [ch] = await db.select().from(channels).where(eq(channels.agentId, agent.id)).limit(1);
  const [conv] = await db.insert(conversations).values({ clientId: client.id, agentId: agent.id, channelId: ch.id, channelType: ch.type, externalId: "doc-1", contactName: "Олег" }).returning();
  const [msg] = await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Вот счёт" }).returning();
  const [docType] = await db
    .insert(clientDocTypes)
    .values({ clientId: client.id, name: "Счёт", purpose: "счёт от поставщика", fields: [{ key: "supplier", label: "Поставщик" }, { key: "amount", label: "Сумма" }, { key: "date", label: "Дата" }] })
    .returning();
  const [tpl] = await db
    .insert(docTemplates)
    .values({
      clientId: client.id,
      name: "КП",
      purpose: "клиент просит КП",
      body: "# КП № {{number}}\n\nДля: {{client}}, {{date}}\n\n**Цена:** {{price}}\nСрок: {{term}}",
      fields: [{ key: "price", label: "Цена с валютой" }, { key: "term", label: "Срок" }],
    })
    .returning();

  const { readDocument, attachDocument } = await import("@/lib/documents/intake");
  const text = await readDocument(Buffer.from("СЧЁТ № 17\nПоставщик: ООО Ромашка\nК оплате: 1 250 €"), "invoice.txt");
  const unsupported = await readDocument(Buffer.from("x"), "photo.exe");
  await attachDocument(msg.id, { name: "invoice.txt", text: text ?? "" }, { clientId: client.id, agentId: agent.id, conversationId: conv.id });
  await new Promise((r) => setTimeout(r, 1500));
  const [msgAfter] = await db.select().from(messages).where(eq(messages.id, msg.id));
  const docs = await db.select().from(clientDocuments).where(eq(clientDocuments.docTypeId, docType.id));

  const { prepareChat } = await import("@/lib/agent/runtime");
  const { streamChat } = await import("@/lib/llm");
  const { docToolName } = await import("@/lib/documents/templates");
  const base = agentConfigSchema.parse(agent.config);
  const config = { ...base, docTemplateIds: [tpl.id], calendar: { ...base.calendar, enabled: false } };
  const run = async (mode: "live" | "dry", c: { name: string; input: object }) => {
    call = c;
    const p = await prepareChat(config, client, [{ role: "user", content: "Пришлите КП" }], { mode, agentId: agent.id, conversationId: conv.id });
    for await (const e of streamChat({ model: "anthropic:claude-haiku-5-5", effort: "low", system: p.system, messages: p.messages, tools: p.tools })) void e;
    return p;
  };
  const p1 = await run("live", { name: docToolName(tpl), input: { price: "96 092 €" } });
  const issued = await db.select().from(generatedDocs).where(eq(generatedDocs.templateId, tpl.id));
  await run("dry", { name: docToolName(tpl), input: { price: "1 €" } });
  const afterDry = await db.select().from(generatedDocs).where(eq(generatedDocs.templateId, tpl.id));
  await new Promise((r) => setTimeout(r, 500));

  await db.delete(generatedDocs).where(eq(generatedDocs.templateId, tpl.id));
  await db.delete(docTemplates).where(eq(docTemplates.id, tpl.id));
  await db.delete(clientDocuments).where(eq(clientDocuments.docTypeId, docType.id));
  await db.delete(clientDocTypes).where(eq(clientDocTypes.id, docType.id));
  await db.delete(conversations).where(eq(conversations.id, conv.id));
  if (notify === undefined) await db.delete(settings).where(eq(settings.key, "notify"));
  else await setSetting("notify", notify);
  stub.close();

  const d = issued[0];
  const result: Record<string, boolean> = {
    "файл прочитан, чужой формат — нет": Boolean(text?.includes("ООО Ромашка")) && unsupported === null,
    "текст документа прикреплён к сообщению": msgAfter.meta?.document?.name === "invoice.txt" && Boolean(msgAfter.meta?.document?.text.includes("К оплате")),
    "модель видит типы и текст": classifyPrompt.includes("[t0] Счёт") && classifyPrompt.includes("supplier — Поставщик") && classifyPrompt.includes("СЧЁТ № 17"),
    "поля сохранены, лишние отброшены": docs.length === 1 && docs[0].fields.supplier === "ООО Ромашка" && docs[0].fields.amount === "1 250 €" && !("extra" in docs[0].fields) && docs[0].conversationId === conv.id,
    "менеджеру в Telegram — тип и поля с подписями": tg.some((x) => x.includes("Счёт") && x.includes("Поставщик") && x.includes("ООО Ромашка")),
    "шаблон передан агенту, подсказка в инструкции": Boolean(p1.tools?.some((t) => t.name === docToolName(tpl))) && p1.system.includes("# Документы для клиента") && p1.system.includes("«КП»"),
    "документ выдан: номер, клиент, цена, пустое поле — прочерк": issued.length >= 1 && d.title === "КП № 1" && d.body.includes("Для: Олег") && d.body.includes("96 092 €") && d.body.includes("Срок: ____") && /^[A-Za-z0-9_-]{16}$/.test(d.id),
    "агенту — ссылка на документ": Boolean(results[0]?.includes(`/d/${d?.id}`)),
    "тестовый режим — документ не выдан": afterDry.length === 1 && Boolean(results[1]?.includes("Test mode")),
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
