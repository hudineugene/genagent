import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  channels,
  clients,
  contactLists,
  contacts,
  conversations,
  outreach,
  outreachMessages,
  type Contact,
  type EmailConfig,
  type Outreach,
} from "@/db/schema";
import { generateJson } from "@/lib/llm/anthropic";
import { streamChat } from "@/lib/llm";
import { apiKey, withKeys } from "@/lib/keys";
import { logUsage } from "@/lib/usage";

/**
 * Персональные рассылки по спискам контактов (холодные письма, письма после вебинара или конференции):
 * 1) список — из CSV / Excel / Google Таблицы, столбцы узнаются по названиям; 2) при включённом исследовании — поиск
 * свежих новостей компании каждого контакта; 3) письмо под человека или его группу; 4) человек проверяет и одобряет;
 * 5) отправка с почтового канала клиента (ответы приходят агенту) или в существующие чаты — ночью не пишем, «стоп» — отписка.
 */
const MODEL = "claude-sonnet-5-5";
const RESEARCH_MODEL = "anthropic:claude-haiku-5-5";
const PER_TICK = 10;
const CONCURRENCY = 3;
export const MAX_CONTACTS = 2000;

const SYNONYMS: Record<"name" | "email" | "telegram" | "phone" | "company" | "website" | "grp", RegExp> = {
  name: /^(имя|ім'я|ім’я|фио|піб|name|full ?name|контакт|клиент|клієнт|участник|учасник)$/i,
  email: /^(e-?mail|почта|пошта|эл\.? ?почта|email address)$/i,
  telegram: /^(telegram|телеграм|tg|ник|нік|username)$/i,
  phone: /^(телефон|phone|тел\.?|мобильный|мобільний|whatsapp)$/i,
  company: /^(компания|компанія|company|организация|організація|бренд)$/i,
  website: /^(сайт|website|site|url|домен)$/i,
  grp: /^(группа|група|сегмент|segment|group|активность|активність|интерес|інтерес|статус)$/i,
};

/** Строки таблицы → контакты: известные столбцы — в поля, остальные — в fields. */
export function rowsToContacts(header: string[], rows: string[][]) {
  const map = header.map((h) => (Object.keys(SYNONYMS) as (keyof typeof SYNONYMS)[]).find((k) => SYNONYMS[k].test(h.trim())) ?? null);
  return rows
    .map((r) => {
      const c = { name: "", email: "", telegram: "", phone: "", company: "", website: "", grp: "", fields: {} as Record<string, string> };
      header.forEach((h, i) => {
        const v = String(r[i] ?? "").trim();
        if (!v) return;
        const k = map[i];
        if (k) c[k] = v;
        else c.fields[h] = v.slice(0, 500);
      });
      c.email = c.email.toLowerCase();
      if (c.telegram && !c.telegram.startsWith("@") && !/^\d+$/.test(c.telegram)) c.telegram = `@${c.telegram.replace(/^https?:\/\/t\.me\//, "")}`;
      return c;
    })
    .filter((c) => c.email || c.telegram || c.phone)
    .slice(0, MAX_CONTACTS);
}

export async function importContacts(clientId: string, name: string, header: string[], rows: string[][], source = "file") {
  const list = rowsToContacts(header, rows);
  if (!list.length) throw new Error("empty");
  const [l] = await db.insert(contactLists).values({ clientId, name: name.slice(0, 100), source }).returning();
  for (let i = 0; i < list.length; i += 200) await db.insert(contacts).values(list.slice(i, i + 200).map((c) => ({ ...c, listId: l.id, clientId })));
  return { list: l, count: list.length };
}

/** Короткая справка о компании из интернета: 1–3 свежих факта или пусто. Нужен поиск в «Внешних сервисах». */
async function research(c: Contact, clientId: string): Promise<string> {
  if (!c.company && !c.website) return "";
  const { getServices } = await import("@/lib/services");
  if (!(await getServices()).webSearch.enabled) return "";
  let text = "";
  const started = Date.now();
  for await (const ev of streamChat({
    model: RESEARCH_MODEL,
    effort: "low",
    system:
      "Ты помогаешь готовить персональное деловое письмо. Найди в интернете 1–3 свежих (за последние месяцы) конкретных факта о компании: новости, запуски, расширение, вакансии, награды, публикации. Ответь 1–3 короткими предложениями по-русски, с источником в скобках. Если ничего свежего и достоверного нет — ответь ровно: нет данных.",
    messages: [{ role: "user", content: `Компания: ${c.company || "—"}${c.website ? `, сайт: ${c.website}` : ""}` }],
    webSearch: { maxUses: 2 },
  })) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "done") await logUsage({ source: "generate", model: ev.servedBy, usage: ev.usage, clientId, ms: Date.now() - started }).catch(() => {});
  }
  const out = text.trim();
  return /^нет данных/i.test(out) ? "" : out.slice(0, 800);
}

async function writeOne(o: Outreach, c: Contact, company: { name: string; description: string; brandVoice: string }, facts: string) {
  const key = apiKey("anthropic");
  if (!key) throw new Error("no_key");
  const brief = (c.grp && o.groupBriefs[c.grp]?.trim()) || o.brief;
  const started = Date.now();
  const extra = Object.entries(c.fields)
    .slice(0, 12)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const { data, usage, model } = await generateJson<{ subject: string; body: string }>(key, MODEL, {
    system: [
      `Ты пишешь персональное письмо от компании «${company.name}».${company.description ? ` О компании: ${company.description}` : ""}`,
      company.brandVoice ? `Голос бренда: ${company.brandVoice}` : "",
      `Задача письма: ${brief}`,
      "Письмо короткое (60–140 слов), живое, без шаблонных фраз и восклицаний. Первая строка — лично про этого человека или его компанию (по фактам ниже или по данным контакта), не общая. Один понятный следующий шаг в конце. Без markdown. Язык — язык задания или контакта.",
      "Не выдумывай факты о человеке и компании: используй только данные контакта и найденные факты. Нет фактов — сделай первую строку по его должности, группе или тому, что он делал (например, был на вебинаре).",
      "subject — тема письма до 60 знаков, без кликбейта. body — текст письма с приветствием по имени, если оно есть, и подписью от компании.",
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: [
      `Контакт: ${c.name || "—"}${c.company ? `, компания ${c.company}` : ""}${c.website ? ` (${c.website})` : ""}`,
      c.grp ? `Группа: ${c.grp}` : "",
      extra ? `Данные: ${extra}` : "",
      facts ? `Свежие факты о компании: ${facts}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } },
    effort: "low",
  });
  await logUsage({ source: "generate", model, usage, clientId: o.clientId, ms: Date.now() - started }).catch(() => {});
  return { subject: data.subject.trim().slice(0, 200), body: data.body.trim().slice(0, 6000) };
}

/** Подготовить черновики для всех контактов списка (в фоне). Потом их проверяет человек. */
export async function generateOutreach(id: string) {
  const [o] = await db.select().from(outreach).where(eq(outreach.id, id));
  if (!o) return;
  return withKeys({ clientId: o.clientId }, async () => {
    const [client] = await db.select().from(clients).where(eq(clients.id, o.clientId));
    const list = await db.select().from(contacts).where(and(eq(contacts.listId, o.listId), eq(contacts.unsubscribed, false)));
    const usable = list.filter((c) => (o.mode === "email" ? Boolean(c.email) : true));
    await db.update(outreach).set({ status: "generating", error: null, updatedAt: new Date() }).where(eq(outreach.id, id));
    // Пересоздаём неотправленные черновики (отправленные не трогаем)
    const sent = new Set((await db.select({ c: outreachMessages.contactId }).from(outreachMessages).where(and(eq(outreachMessages.outreachId, id), eq(outreachMessages.status, "sent")))).map((r) => r.c));
    await db.delete(outreachMessages).where(and(eq(outreachMessages.outreachId, id), inArray(outreachMessages.status, ["pending", "ready", "approved", "failed", "skipped"])));
    const todo = usable.filter((c) => !sent.has(c.id));
    let i = 0;
    let lastError: string | null = null;
    const work = async () => {
      while (i < todo.length) {
        const c = todo[i++];
        try {
          const facts = o.research ? await research(c, o.clientId).catch(() => "") : "";
          const m = await writeOne(o, c, { name: client?.name ?? "", description: client?.description ?? "", brandVoice: client?.brandVoice ?? "" }, facts);
          await db.insert(outreachMessages).values({ outreachId: id, contactId: c.id, subject: m.subject, body: m.body, research: facts, status: "ready" });
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          await db.insert(outreachMessages).values({ outreachId: id, contactId: c.id, status: "failed", error: lastError.slice(0, 300) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, work));
    await db.update(outreach).set({ status: "review", error: lastError, updatedAt: new Date() }).where(eq(outreach.id, id));
  });
}

const FOOTER: Record<string, string> = {
  ru: "Если не хотите получать такие письма — ответьте «стоп».",
  uk: "Якщо не бажаєте отримувати такі листи — дайте відповідь «стоп».",
};

/** Отправить одобренные письма (до PER_TICK за раз). Ночью — ждём утра. */
export async function sendOutreachTick(now = new Date()) {
  const { quietUntil } = await import("@/lib/campaigns/engine");
  if (quietUntil(now)) return 0;
  const due = await db
    .select({ m: outreachMessages, o: outreach, c: contacts })
    .from(outreachMessages)
    .innerJoin(outreach, eq(outreach.id, outreachMessages.outreachId))
    .innerJoin(contacts, eq(contacts.id, outreachMessages.contactId))
    .where(and(eq(outreachMessages.status, "approved"), eq(outreach.status, "sending")))
    .limit(PER_TICK);
  let n = 0;
  const { addMessage, deliver, upsertConversation } = await import("@/lib/conversations");
  for (const { m, o, c } of due) {
    const fail = (error: string) => db.update(outreachMessages).set({ status: "failed", error }).where(eq(outreachMessages.id, m.id));
    try {
      if (c.unsubscribed) {
        await db.update(outreachMessages).set({ status: "skipped", error: "unsubscribed" }).where(eq(outreachMessages.id, m.id));
        continue;
      }
      if (o.mode === "email") {
        const [ch] = o.channelId ? await db.select().from(channels).where(eq(channels.id, o.channelId)) : [];
        if (!ch || ch.type !== "email") {
          await fail("no_channel");
          continue;
        }
        const { conversation } = await upsertConversation(ch, c.email, { name: c.name, handle: c.email });
        if (conversation.context?.optOut) {
          await db.update(contacts).set({ unsubscribed: true }).where(eq(contacts.id, c.id));
          await db.update(outreachMessages).set({ status: "skipped", error: "unsubscribed" }).where(eq(outreachMessages.id, m.id));
          continue;
        }
        const cfg = ch.config as EmailConfig;
        const { smtpTransport } = await import("@/lib/channels/email-send");
        const text = `${m.body}\n\n—\n${FOOTER.ru}`;
        const info = await smtpTransport(cfg).sendMail({ from: { name: cfg.fromName || cfg.address, address: cfg.address }, to: c.email, subject: m.subject, text });
        // Письмо — в разговор: когда человек ответит, агент увидит, о чём писали
        await db.update(conversations).set({ context: { ...conversation.context, subject: m.subject } }).where(eq(conversations.id, conversation.id));
        await addMessage(conversation.id, "assistant", `${m.subject}\n\n${m.body}`, { externalId: info.messageId ?? undefined, meta: { campaign: { id: o.id, name: o.name, step: 0 } } });
      } else {
        const { findChat } = await import("@/lib/reach");
        const found = await findChat(o.clientId, c);
        if (!found) {
          await db.update(outreachMessages).set({ status: "skipped", error: "no_chat" }).where(eq(outreachMessages.id, m.id));
          continue;
        }
        if (found.conv.context?.optOut) {
          await db.update(outreachMessages).set({ status: "skipped", error: "unsubscribed" }).where(eq(outreachMessages.id, m.id));
          continue;
        }
        const externalId = await deliver(found.channel, found.conv, m.body);
        await addMessage(found.conv.id, "assistant", m.body, { externalId: externalId ?? undefined, meta: { campaign: { id: o.id, name: o.name, step: 0 } } });
      }
      await db.update(outreachMessages).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(outreachMessages.id, m.id));
      n++;
    } catch (e) {
      await fail((e instanceof Error ? e.message : String(e)).slice(0, 300));
    }
  }
  // Рассылки, где не осталось одобренных писем, — завершены
  const active = await db.select({ id: outreach.id }).from(outreach).where(eq(outreach.status, "sending"));
  for (const a of active) {
    const [left] = await db.select({ id: outreachMessages.id }).from(outreachMessages).where(and(eq(outreachMessages.outreachId, a.id), eq(outreachMessages.status, "approved"))).limit(1);
    if (!left) await db.update(outreach).set({ status: "done", updatedAt: new Date() }).where(eq(outreach.id, a.id));
  }
  return n;
}

/** «стоп» в ответ на письмо — контакт отписывается во всех списках клиента. */
export async function unsubscribeEmail(clientId: string, email: string) {
  await db.update(contacts).set({ unsubscribed: true }).where(and(eq(contacts.clientId, clientId), eq(contacts.email, email.toLowerCase())));
}

const g = globalThis as unknown as { __outreachTimer?: NodeJS.Timeout };
export function startOutreach() {
  if (g.__outreachTimer) return;
  g.__outreachTimer = setInterval(() => void sendOutreachTick().catch((e) => console.error("outreach tick failed", e)), 60_000);
  g.__outreachTimer.unref?.();
}
