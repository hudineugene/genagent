/** Утренняя сводка лидов: кто попадает, порядок, текст.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-leads.ts */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, channels, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const [ch] = await db.select().from(channels).where(eq(channels.type, "api")).limit(1);
  const now = Date.now();
  const made: string[] = [];
  const conv = async (name: string, opts: { test?: boolean; attention?: boolean; memory?: string[] } = {}) => {
    const [c] = await db
      .insert(conversations)
      .values({
        clientId: ch.clientId,
        agentId: ch.agentId,
        channelId: ch.id,
        channelType: "api",
        externalId: `lead-${name}-${now}`,
        contactName: name,
        isTest: opts.test ?? false,
        needsAttention: opts.attention ?? false,
        context: opts.memory ? { memory: { facts: opts.memory, at: now, upto: now } } : null,
      })
      .returning();
    made.push(c.id);
    return c;
  };
  const msg = (c: string, role: "user" | "system" | "operator", text: string, ago: number, meta?: object) =>
    db.insert(messages).values({ conversationId: c, role, text, status: "sent", createdAt: new Date(now - ago), meta: meta ?? null });

  const upset = await conv("Злой", { attention: true });
  await msg(upset.id, "user", "Где мой заказ?!", 3 * 3600_000);
  await msg(upset.id, "system", "handoff", 3 * 3600_000, { summary: "Ищет: статус заказа #12\nЖдёт от менеджера: ответ", upset: true });
  const wait1 = await conv("Анна", { attention: true });
  await msg(wait1.id, "system", "handoff", 5 * 3600_000, { summary: "Ищет: виллу у моря до 600 000 €" });
  const wait2 = await conv("Борис", { attention: true });
  await msg(wait2.id, "system", "handoff", 1 * 3600_000, { summary: "Ищет: апартаменты в Финестрате" });
  const done = await conv("Вера");
  await msg(done.id, "system", "handoff", 6 * 3600_000, { summary: "Ищет: ипотеку для нерезидента" });
  await msg(done.id, "operator", "Добрый день! Расскажу про ипотеку…", 5 * 3600_000);
  const result = await conv("Глеб", { memory: ["Зовут Глеб", "Хочет пак со своим псом"] });
  await db.insert(agentEvents).values({ agentId: ch.agentId, clientId: ch.clientId, channelId: ch.id, conversationId: result.id, externalUserId: result.externalId, type: "brief_sent", label: "Бриф отправлен", assisted: true });
  const test = await conv("Тестер", { test: true, attention: true });
  await msg(test.id, "system", "handoff", 2 * 3600_000, { summary: "Ищет: тест" });
  const quiet = await conv("Тихий");
  await msg(quiet.id, "user", "Привет", 3600_000);

  const { collectLeads, leadsHtml } = await import("@/lib/agent/leads");
  const leads = (await collectLeads()).filter((l) => made.includes(l.conversationId));
  const html = leadsHtml(leads, "https://admin.example");

  await db.delete(agentEvents).where(inArray(agentEvents.conversationId, made));
  await db.delete(conversations).where(inArray(conversations.id, made));

  const order = leads.map((l) => l.who).join(",");
  const checks: Record<string, boolean> = {
    "лиды: передачи и результаты, без теста и пустых": order.split(",").sort().join(",") === ["Анна", "Борис", "Вера", "Глеб", "Злой"].sort().join(","),
    "порядок: недовольный, дольше ждущий, ждущий, результат, отвеченный": order === "Злой,Анна,Борис,Глеб,Вера",
    "что хочет — из выжимки": leads.find((l) => l.who === "Анна")?.wants === "виллу у моря до 600 000 €",
    "результат без передачи — по событию": leads.find((l) => l.who === "Глеб")?.status === "result" && leads.find((l) => l.who === "Глеб")?.wants === "Бриф отправлен",
    "отвеченный — «ответили»": leads.find((l) => l.who === "Вера")?.status === "answered",
    "текст: заголовок, статусы, ссылки": html.includes("Лиды за сутки: 5") && html.includes("ждут ответа: 3") && html.includes("🔴 недоволен, ждёт 3 ч") && html.includes("⏳ ждёт 5 ч") && html.includes(`/inbox?c=${wait1.id}`),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
