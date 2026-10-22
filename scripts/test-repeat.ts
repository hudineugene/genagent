/** Повторный вопрос клиента: распознаём (та же кнопка, тот же текст) и даём агенту прямую пометку.
 *  DB_PATH=<копия caltest> npx tsx scripts/test-repeat.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients } from "@/db/schema";
import { agentConfigSchema } from "@/lib/agent/types";
import { isRepeat, prepareChat } from "@/lib/agent/runtime";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string) => ({ role: "assistant" as const, content });
  const [row] = await db.select({ agent: agents, client: clients }).from(agents).innerJoin(clients, eq(clients.id, agents.clientId)).limit(1);
  const config = agentConfigSchema.parse(row.agent.config);
  const same = await prepareChat(config, row.client, [u("🇪🇸 Как купить"), a("Этапы: NIE, счёт, юрист…"), u("🇪🇸 Как купить")]);
  const other = await prepareChat(config, row.client, [u("Как купить?"), a("Этапы…"), u("А налоги?")]);
  // Та же кнопка через несколько дней — новый запрос, не повтор
  const later = await prepareChat(config, row.client, [u("🏘 Объекты"), a("Вот объекты…"), u("🏘 Объекты")], { mode: "dry" }, undefined, { recentRepeat: false });
  const checks: Record<string, boolean> = {
    "та же кнопка — повтор": isRepeat([u("🇪🇸 Как купить"), a("…"), u("🇪🇸 Как купить")]),
    "тот же текст другим регистром и знаками — повтор": isRepeat([u("Як замовити стікерпак?"), a("…"), u("як замовити стікерпак")]),
    "другой вопрос — не повтор": !isRepeat([u("Как купить?"), a("…"), u("А налоги?")]),
    "первое сообщение — не повтор": !isRepeat([u("Привет")]),
    "агент получает пометку о повторе": String(same.messages.at(-1)?.content).includes("Клиент повторил своё прошлое сообщение"),
    "без повтора пометки нет": !String(other.messages.at(-1)?.content).includes("Клиент повторил"),
    "та же кнопка через долгий перерыв — новый запрос": !String(later.messages.at(-1)?.content).includes("Клиент повторил"),
  };
  console.log(checks);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})();
