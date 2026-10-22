import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, kbSources } from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";
import { getSetting, setSetting } from "@/lib/settings";
import { agentConfigSchema } from "@/lib/agent/types";

/**
 * Сверка данных агента: одни и те же объекты описаны в нескольких местах (ключевые факты и правила агента, каталог
 * от бота, документы базы знаний) — после правки одного другие устаревают, и агент называет разные цены. После
 * каждого изменения (с паузой, чтобы серия правок дала одну проверку) дешёвая модель ищет расхождения в цифрах,
 * статусах и сроках; новые — владельцу в Telegram. Тот же набор данных повторно не проверяем.
 */
const CHECK_MODEL = "claude-haiku-5-5";
const DEBOUNCE_MS = 3 * 60_000;
const MAX_CHARS = 150_000;
const key = (agentId: string) => `consistency:${agentId}`;

export type Conflict = { item: string; values: string[]; where: string };
type Stored = { hash: string; conflicts: Conflict[]; checkedAt: number };

const g = globalThis as unknown as { __consistencyTimers?: Map<string, ReturnType<typeof setTimeout>> };
const timers = (g.__consistencyTimers ??= new Map());

/** Запланировать сверку агента (повторный вызов в течение паузы переносит проверку). */
export function scheduleConsistency(agentId: string) {
  clearTimeout(timers.get(agentId));
  const t = setTimeout(() => {
    timers.delete(agentId);
    void checkConsistency(agentId).catch((e) => console.error("consistency check failed", agentId, e));
  }, DEBOUNCE_MS);
  t.unref?.();
  timers.set(agentId, t);
}

/** Изменилась база знаний клиента — сверить всех его агентов, которые её используют. */
export async function scheduleConsistencyForClient(clientId: string, sourceId?: string) {
  const list = await db.select({ id: agents.id, config: agents.config }).from(agents).where(eq(agents.clientId, clientId));
  for (const a of list) {
    const ids = (a.config as { kbSourceIds?: string[] | null }).kbSourceIds;
    if (!sourceId || !ids || ids.includes(sourceId)) scheduleConsistency(a.id);
  }
}

export async function lastConsistency(agentId: string) {
  return (await getSetting<Stored>(key(agentId))) ?? null;
}

/** Документы агента для сверки: его тексты и источники базы знаний. */
async function material(agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!row) return null;
  const cfg = agentConfigSchema.safeParse(row.config);
  if (!cfg.success) return null;
  const c = cfg.data;
  const where = [eq(kbSources.clientId, row.clientId), eq(kbSources.status, "ready")];
  if (c.kbSourceIds) {
    if (!c.kbSourceIds.length) where.push(eq(kbSources.id, "-"));
    else where.push(inArray(kbSources.id, c.kbSourceIds));
  }
  const sources = await db.select({ id: kbSources.id, title: kbSources.title, content: kbSources.content }).from(kbSources).where(and(...where));
  sources.sort((a, b) => a.id.localeCompare(b.id));
  const docs = [
    { title: "Настройки агента: описание", content: c.description },
    { title: "Настройки агента: ключевые факты", content: c.knowledge },
    { title: "Настройки агента: правила", content: c.rules },
    ...sources.map((s) => ({ title: `База знаний: ${s.title}`, content: s.content ?? "" })),
  ].filter((d) => d.content.trim());
  let text = "";
  for (const d of docs) {
    if (text.length >= MAX_CHARS) break;
    text += `\n\n=== ${d.title} ===\n${d.content}`.slice(0, MAX_CHARS - text.length);
  }
  return { agent: row, text: text.trim() };
}

/**
 * Сверить сейчас. Возвращает найденные расхождения (null — нечего сверять или нет ключа).
 * notify=false — не слать в Telegram (ручной запуск из админки показывает результат сам).
 */
export async function checkConsistency(agentId: string, opts: { force?: boolean; notify?: boolean } = {}): Promise<Conflict[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const m = await material(agentId);
  if (!m || !m.text) return null;
  const hash = createHash("sha256").update(m.text).digest("hex");
  const prev = await lastConsistency(agentId);
  if (!opts.force && prev?.hash === hash) return prev.conflicts;

  const started = Date.now();
  const { data, usage, model } = await generateJson<{ conflicts: Conflict[] }>(apiKey, CHECK_MODEL, {
    system: [
      "Ты сверяешь данные ИИ-консультанта компании. Ниже — его настройки и документы базы знаний; одни и те же объекты, услуги и условия могут быть описаны в нескольких местах.",
      "Найди только настоящие противоречия: один и тот же объект, товар или условие, у которого в разных местах разные цена, статус (в продаже / продано / строится), сроки, площадь, количество, адрес, телефон или другие конкретные факты.",
      "Не считай противоречием: «от X» и конкретные цены выше X; разные объекты с похожими названиями; перевод одного и того же на другой язык; более подробное и более краткое описание одного факта; округление в пределах одного числа («около 10%» и «10%»).",
      "Для каждого противоречия: item — что именно (объект и параметр, коротко), values — расходящиеся значения как они написаны, where — где каждое значение (названия разделов через «;»). Пиши по-русски. Нет противоречий — пустой список.",
    ].join("\n"),
    prompt: m.text,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["conflicts"],
      properties: {
        conflicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["item", "values", "where"],
            properties: { item: { type: "string" }, values: { type: "array", items: { type: "string" } }, where: { type: "string" } },
          },
        },
      },
    },
    effort: "low",
  });
  await logUsage({ source: "insights", model, usage, agentId, clientId: m.agent.clientId, ms: Date.now() - started }).catch(() => {});
  const conflicts = (data.conflicts ?? [])
    .filter((x) => x.item?.trim() && (x.values ?? []).length >= 2)
    .slice(0, 10)
    .map((x) => ({ item: x.item.trim().slice(0, 200), values: x.values.map((v) => v.trim().slice(0, 200)).slice(0, 4), where: (x.where ?? "").trim().slice(0, 300) }));
  await setSetting(key(agentId), { hash, conflicts, checkedAt: Date.now() } satisfies Stored);

  // Владельцу — только новые расхождения (уже известные не повторяем при каждой правке)
  const known = new Set((prev?.conflicts ?? []).map((x) => x.item.toLowerCase()));
  const fresh = conflicts.filter((x) => !known.has(x.item.toLowerCase()));
  if (fresh.length && opts.notify !== false) void import("@/lib/notify/telegram").then((n) => n.notifyConflicts(agentId, fresh));
  return conflicts;
}
