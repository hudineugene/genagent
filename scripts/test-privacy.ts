/** GDPR: выгрузка всех данных человека по всем его разговорам у клиента, полное удаление (с файлами), срок
 *  хранения, список обработчиков и шаблон DPA.  DB_PATH=<копия caltest> npx tsx scripts/test-privacy.ts */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  channels,
  clientDocuments,
  clients,
  contactLists,
  contacts,
  conversations,
  formResponses,
  clientForms,
  learners,
  loyaltyAccounts,
  loyaltyPrograms,
  messages,
} from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { MEDIA_DIR } = await import("@/lib/media");
  const { DOCS_DIR } = await import("@/lib/documents/archive");
  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Privacy Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "privacy-agent" }).returning();
  const [tg] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "telegram", name: "bot", config: { token: "1:x" } as never }).returning();
  const [ig] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "instagram", name: "ig", config: {} as never }).returning();
  const [conv1] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tg.id, channelType: "telegram", externalId: "1001", contactName: "Мария", contactHandle: "@maria_p", context: { memory: { facts: ["Любит синий цвет"], at: 1, upto: 1 } } as never }).returning();
  const [conv2] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ig.id, channelType: "instagram", externalId: "ig-77", contactName: "Мария", contactHandle: "@maria_p" }).returning();
  const [other] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tg.id, channelType: "telegram", externalId: "2002", contactName: "Иван", contactHandle: "@ivan" }).returning();
  const thumb = `${crypto.randomUUID()}.jpg`;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, thumb), "x");
  await db.insert(messages).values([
    { conversationId: conv1.id, role: "user", text: "Хочу синий диван", meta: { thumb } },
    { conversationId: conv1.id, role: "assistant", text: "Есть синий!" },
    { conversationId: conv2.id, role: "user", text: "Привет из Instagram" },
    { conversationId: other.id, role: "user", text: "Я Иван" },
  ] as never);
  const [form] = await db.insert(clientForms).values({ clientId: c.id, name: "Анкета", fields: [] }).returning();
  await db.insert(formResponses).values({ formId: form.id, clientId: c.id, conversationId: conv1.id, answers: { phone: "+380671234567" } });
  const docFile = `${crypto.randomUUID()}.pdf`;
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, docFile), "pdf");
  await db.insert(clientDocuments).values({ clientId: c.id, conversationId: conv1.id, filename: "passport.pdf", file: docFile, fields: { name: "Мария" } });
  const [prog] = await db.insert(loyaltyPrograms).values({ clientId: c.id, name: "Бонусы", apiKey: "lp_p" }).returning();
  await db.insert(loyaltyAccounts).values({ programId: prog.id, contact: "maria_p", name: "Мария", balance: 50, conversationId: conv1.id });
  await db.insert(learners).values({ clientId: c.id, contact: "maria_p", name: "Мария", goal: "продажи" });
  const [list] = await db.insert(contactLists).values({ clientId: c.id, name: "Список" }).returning();
  await db.insert(contacts).values([
    { listId: list.id, clientId: c.id, name: "Мария", telegram: "@maria_p" },
    { listId: list.id, clientId: c.id, name: "Иван", telegram: "@ivan" },
  ]);

  const { exportPerson, erasePerson, retentionTick } = await import("@/lib/privacy");
  const exp = await exportPerson(conv2.id);
  const r = await erasePerson(conv1.id);
  const left = {
    convs: (await db.select().from(conversations).where(eq(conversations.clientId, c.id))).map((x) => x.contactName),
    forms: (await db.select().from(formResponses).where(eq(formResponses.clientId, c.id))).length,
    docs: (await db.select().from(clientDocuments).where(eq(clientDocuments.clientId, c.id))).length,
    loyalty: (await db.select().from(loyaltyAccounts).where(eq(loyaltyAccounts.programId, prog.id))).length,
    learners: (await db.select().from(learners).where(eq(learners.clientId, c.id))).length,
    contacts: (await db.select().from(contacts).where(eq(contacts.listId, list.id))).map((x) => x.name),
    thumb: fs.existsSync(path.join(MEDIA_DIR, thumb)),
    docFile: fs.existsSync(path.join(DOCS_DIR, docFile)),
  };

  // Срок хранения: 30 дней — старый разговор удаляется, свежий остаётся
  await db.update(clients).set({ retentionDays: 30 }).where(eq(clients.id, c.id));
  const [old] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: tg.id, channelType: "telegram", externalId: "3003", contactName: "Старый", lastMessageAt: new Date(Date.now() - 40 * 86400_000) }).returning();
  const removed = await retentionTick();
  const afterRetention = (await db.select().from(conversations).where(eq(conversations.clientId, c.id))).map((x) => x.contactName).sort();

  const { subprocessors, dpaHtml } = await import("@/lib/dpa");
  const subs = await subprocessors(c.id);
  const dpa = (await dpaHtml(c.id)) ?? "";

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  void old;

  const checks: Record<string, boolean> = {
    "выгрузка: оба разговора человека (Telegram и Instagram), без чужого": exp?.conversations.length === 2 && JSON.stringify(exp).includes("Привет из Instagram") && !JSON.stringify(exp).includes("Я Иван"),
    "выгрузка: память, анкета, документ, баллы, обучение, списки": Boolean(exp?.conversations.some((x) => x.memory.includes("Любит синий цвет"))) && exp?.formResponses.length === 1 && exp.documents[0]?.filename === "passport.pdf" && exp.loyalty[0]?.balance === 50 && exp.learning.length === 1 && exp.contactLists.length === 1,
    "удаление: все разговоры человека и связанные данные": r?.conversations === 2 && left.convs.join() === "Иван" && left.forms === 0 && left.docs === 0 && left.loyalty === 0 && left.learners === 0 && left.contacts.join() === "Иван",
    "удаление: файлы превью и документов стёрты": !left.thumb && !left.docFile,
    "срок хранения: старый разговор удалён, свежий остался": removed >= 1 && afterRetention.join() === "Иван",
    "обработчики по подключённому и DPA со сроком хранения": subs.some((s) => s.name.startsWith("Anthropic")) && subs.some((s) => s.name.startsWith("Telegram")) && subs.some((s) => s.name.startsWith("Meta")) && dpa.includes("30 дней") && dpa.includes("Privacy Test") && dpa.includes("ст. 50"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
