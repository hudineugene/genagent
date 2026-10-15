/** «Продолжить в Telegram»: перенос разговора с сайта в бота на копии базы (без ИИ): DB_PATH=<копия caltest> npx tsx scripts/test-link.ts */
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { channels, conversations, messages } from "@/db/schema";
import { linkWidgetConversation, widgetLinkToken } from "@/lib/channels/link";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  await runMigrations(db);
  const widget = (await db.select().from(channels).where(eq(channels.type, "widget")))[0];
  if (!widget) throw new Error("нет виджета");
  // Временный «Свой бот» того же клиента — удаляется в конце.
  const [api] = await db
    .insert(channels)
    .values({ clientId: widget.clientId, agentId: widget.agentId, type: "api", name: "link-test", config: { key: "ga_link-test", label: "link-test" } } as never)
    .returning();
  const now = Date.now();
  const [site] = await db
    .insert(conversations)
    .values({ clientId: widget.clientId, agentId: widget.agentId, channelId: widget.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "" } as never)
    .returning();
  await db.insert(messages).values([
    { conversationId: site.id, role: "assistant", text: "Привіт! Чим допомогти?", createdAt: new Date(now - 5000) },
    { conversationId: site.id, role: "user", text: "Хочу стікери з моїм котом", createdAt: new Date(now - 4000) },
    { conversationId: site.id, role: "assistant", text: "Чудово! Статичні чи анімовані?", createdAt: new Date(now - 3000) },
  ] as never);

  const token = await widgetLinkToken(site);
  const again = await widgetLinkToken((await db.select().from(conversations).where(eq(conversations.id, site.id)))[0]);
  const userId = "link-test-" + now;
  const r = await linkWidgetConversation(api, token, { id: userId, name: "Тест" });
  const second = await linkWidgetConversation(api, token, { id: userId });
  const target = r.linked ? r.conversationId : "";
  const copied = target ? await db.select().from(messages).where(eq(messages.conversationId, target)).orderBy(asc(messages.createdAt)) : [];
  const [siteAfter] = await db.select().from(conversations).where(eq(conversations.id, site.id));
  const checks: Record<string, boolean> = {
    "код переиспользуется, пока действует": token === again && /^[A-Za-z0-9]{8,40}$/.test(token),
    "разговор перенесён": r.linked && r.copied === 3,
    "история с сайта в разговоре бота": copied.filter((m) => m.meta?.fromSite).map((m) => m.text).join("|") === "Привіт! Чим допомогти?|Хочу стікери з моїм котом|Чудово! Статичні чи анімовані?",
    "служебная запись в боте": copied.some((m) => m.role === "system" && m.text === "linked_widget"),
    "код одноразовый": !second.linked,
    "на сайте отмечено, куда ушёл": siteAfter.context?.linkedTo === target && !siteAfter.context?.linkToken,
  };
  console.log(checks);
  await db.delete(conversations).where(inArray(conversations.id, [site.id, target].filter(Boolean)));
  await db.delete(channels).where(eq(channels.id, api.id));
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
