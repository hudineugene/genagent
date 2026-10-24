/** Контент: реклама — до 10 вариантов за раз, перепаковка одной статьи в отдельные тексты для каждой площадки,
 *  SEO-бриф с анализом поисковой выдачи (поиск в интернете). Модель — макет. DB_PATH=<копия caltest> npx tsx scripts/test-content-more.ts */
import http from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, contentItems, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const systems: string[] = [];
  let searches = 0;
  const ev = (type: string, d: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      let text: string;
      if (b.tools?.some((t: { type?: string }) => String(t.type ?? "").startsWith("web_search"))) {
        searches++;
        text = "Топ-1: «Виллы в Финестрате — гид 2026», H2: цены, районы. Не хватает: налоги для нерезидентов.";
      } else {
        const sys = typeof b.system === "string" ? b.system : JSON.stringify(b.system);
        systems.push(sys);
        const n = Number(/Сделай ровно (\d+) текстов/.exec(sys)?.[1] ?? /Сделай (\d+) /.exec(sys)?.[1] ?? 1);
        text = JSON.stringify({ variants: Array.from({ length: n + 2 }, (_, i) => ({ title: `Вариант ${i + 1}`, text: `Текст ${i + 1}` })) });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
          ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
          ev("content_block_stop", { index: 0 }) +
          ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
          ev("message_stop", {}),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(4067, r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:4067";
  process.env.ANTHROPIC_API_KEY = "stub";
  const services = await getSetting("services");
  await setSetting("services", { webSearch: { enabled: true, maxUses: 3 } });
  const [agent] = await db.select().from(agents).limit(1);
  const clientId = agent.clientId;
  await db.delete(contentItems).where(eq(contentItems.clientId, clientId));

  const { generateContent } = await import("@/lib/content/studio");
  const ads = await generateContent(clientId, { kind: "ad", platform: "facebook", brief: "Реклама онлайн-показа", tone: "", length: "short", variants: 10, useKb: false });
  const rep = await generateContent(clientId, { kind: "repurpose", platform: "telegram", platforms: ["telegram", "instagram", "linkedin", "email"], brief: "Длинная статья о покупке виллы в Испании…", tone: "", length: "medium", variants: 1, useKb: false });
  const repSys = systems.at(-1) ?? "";
  const seo = await generateContent(clientId, { kind: "seo", platform: "site", brief: "виллы в Финестрате купить", tone: "", length: "long", variants: 1, useKb: false });
  const seoSys = systems.at(-1) ?? "";
  const tooMany = await generateContent(clientId, { kind: "post", platform: "telegram", brief: "Пост", tone: "", length: "short", variants: 9, useKb: false });

  await db.delete(contentItems).where(eq(contentItems.clientId, clientId));
  if (services === undefined) await db.delete(settings).where(eq(settings.key, "services"));
  else await setSetting("services", services);
  void clients;
  stub.close();

  const result: Record<string, boolean> = {
    "реклама: 10 вариантов одной партией": ads.length === 10 && new Set(ads.map((a) => a.batch)).size === 1,
    "перепаковка: по тексту на каждую площадку, площадки проставлены": rep.length === 4 && rep.map((r) => r.platform).join(",") === "telegram,instagram,linkedin,email" && repSys.includes("по одному тексту на каждую") && repSys.includes("Исходный материал") === false,
    "SEO-бриф: выдача проанализирована и передана в задание": searches >= 1 && seoSys.includes("Анализ поисковой выдачи") && seoSys.includes("налоги для нерезидентов") && seo.length === 1,
    "пост: больше 3 вариантов не делает": tooMany.length === 3,
  };
  console.log(result);
  process.exit(Object.values(result).every(Boolean) ? 0 : 1);
})();
