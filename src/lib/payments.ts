import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, channels, clientPayments, conversations, payments, type ClientPayments, type Payment, type PaymentStatus, type PayProvider } from "@/db/schema";
import type { AgentTool } from "@/lib/llm";
import type { ToolContext } from "@/lib/agent/tools";
import { publicUrl } from "@/lib/settings";

/**
 * Оплата в диалоге: агент выдаёт ссылку на оплату (LiqPay, WayForPay или Monobank — эквайринг клиента), банк
 * сообщает результат на наш вебхук, статус перепроверяется у банка. Оплачено — клиенту подтверждение в тот же чат,
 * команде и владельцу — уведомление, во внешние системы — событие «payment». Тест-чат ссылок не создаёт.
 */
const LIQPAY = () => (process.env.LIQPAY_URL ?? "https://www.liqpay.ua").replace(/\/$/, "");
const WAYFORPAY = () => (process.env.WAYFORPAY_URL ?? "https://api.wayforpay.com").replace(/\/$/, "");
const MONOBANK = () => (process.env.MONOBANK_URL ?? "https://api.monobank.ua").replace(/\/$/, "");
const MONO_CCY: Record<string, number> = { UAH: 980, USD: 840, EUR: 978 };

export const PAY_CURRENCIES = ["UAH", "USD", "EUR"] as const;

export async function getPayments(clientId: string): Promise<ClientPayments | null> {
  const [row] = await db.select().from(clientPayments).where(eq(clientPayments.clientId, clientId));
  return row ?? null;
}

/** Ключи заданы полностью для выбранного банка. */
export function credentialsReady(p: Pick<ClientPayments, "provider" | "credentials">) {
  const c = p.credentials;
  if (p.provider === "liqpay") return Boolean(c.publicKey && c.privateKey);
  if (p.provider === "wayforpay") return Boolean(c.merchant && c.secret && c.domain);
  return Boolean(c.token);
}

const liqSign = (priv: string, data: string) => createHash("sha1").update(priv + data + priv).digest("base64");
const md5 = (secret: string, parts: (string | number)[]) => createHmac("md5", secret).update(parts.join(";")).digest("hex");
const money = (n: number) => Math.round(n * 100) / 100;

function callbackUrl(provider: PayProvider, clientId: string) {
  const base = publicUrl();
  if (!base) throw new Error("no_public_url");
  return `${base}/api/webhooks/pay/${provider}/${clientId}`;
}

/** Короткая ссылка для клиента (ведёт на страницу оплаты банка). */
export function shortLink(orderId: string) {
  return `${publicUrl() ?? ""}/api/webhooks/pay/go/${orderId}`;
}

/** Счёт у банка: ссылка на страницу оплаты и номер счёта у банка (если есть). */
async function createAtBank(cfg: ClientPayments, orderId: string, amount: number, description: string): Promise<{ url: string; externalId?: string }> {
  const c = cfg.credentials;
  const server = callbackUrl(cfg.provider, cfg.clientId);
  if (cfg.provider === "liqpay") {
    const data = Buffer.from(
      JSON.stringify({ version: 3, public_key: c.publicKey, action: "pay", amount, currency: cfg.currency, description, order_id: orderId, server_url: server }),
    ).toString("base64");
    return { url: `${LIQPAY()}/api/3/checkout?data=${encodeURIComponent(data)}&signature=${encodeURIComponent(liqSign(c.privateKey ?? "", data))}` };
  }
  if (cfg.provider === "wayforpay") {
    const orderDate = Math.floor(Date.now() / 1000);
    const body = {
      transactionType: "CREATE_INVOICE",
      merchantAccount: c.merchant,
      merchantDomainName: c.domain,
      merchantAuthType: "SimpleSignature",
      apiVersion: 1,
      serviceUrl: server,
      orderReference: orderId,
      orderDate,
      amount,
      currency: cfg.currency,
      productName: [description],
      productPrice: [amount],
      productCount: [1],
      orderTimeout: 86400,
      merchantSignature: md5(c.secret ?? "", [c.merchant ?? "", c.domain ?? "", orderId, orderDate, amount, cfg.currency, description, 1, amount]),
    };
    const res = await fetch(`${WAYFORPAY()}/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => ({}))) as { invoiceUrl?: string; reason?: string; reasonCode?: number };
    if (!j.invoiceUrl) throw new Error(`wayforpay: ${j.reason ?? res.status}`);
    return { url: j.invoiceUrl };
  }
  const ccy = MONO_CCY[cfg.currency];
  if (!ccy) throw new Error("currency");
  const res = await fetch(`${MONOBANK()}/api/merchant/invoice/create`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Token": c.token ?? "" },
    body: JSON.stringify({ amount: Math.round(amount * 100), ccy, merchantPaymInfo: { reference: orderId, destination: description }, webHookUrl: server, validity: 86400 }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { invoiceId?: string; pageUrl?: string; errText?: string };
  if (!j.pageUrl || !j.invoiceId) throw new Error(`monobank: ${j.errText ?? res.status}`);
  return { url: j.pageUrl, externalId: j.invoiceId };
}

/** Создать оплату: запись, счёт у банка, короткая ссылка. */
export async function createPayment(
  clientId: string,
  input: { amount: number; description: string; conversationId?: string | null; agentId?: string | null },
): Promise<{ payment?: Payment; link?: string; error?: string }> {
  const cfg = await getPayments(clientId);
  if (!cfg?.enabled || !credentialsReady(cfg)) return { error: "not_configured" };
  const amount = money(input.amount);
  if (!(amount > 0)) return { error: "amount" };
  if (cfg.maxAmount != null && amount > cfg.maxAmount) return { error: "too_much" };
  const description = input.description.trim().slice(0, 200) || "Оплата";
  // Повторная просьба той же оплаты в течение 30 минут — та же ссылка, а не новый счёт
  if (input.conversationId) {
    const [same] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.conversationId, input.conversationId), eq(payments.status, "created"), eq(payments.amount, amount), gte(payments.createdAt, new Date(Date.now() - 30 * 60_000))))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (same) return { payment: same, link: shortLink(same.orderId) };
  }
  const orderId = `ga${randomBytes(9).toString("base64url")}`;
  const bank = await createAtBank(cfg, orderId, amount, description);
  const [row] = await db
    .insert(payments)
    .values({ clientId, conversationId: input.conversationId ?? null, agentId: input.agentId ?? null, provider: cfg.provider, orderId, externalId: bank.externalId ?? null, amount, currency: cfg.currency, description, url: bank.url })
    .returning();
  return { payment: row, link: shortLink(orderId) };
}

const LIQ_STATUS: Record<string, PaymentStatus> = { success: "paid", sandbox: "paid", failure: "failed", error: "failed", reversed: "refunded" };
const WFP_STATUS: Record<string, PaymentStatus> = { Approved: "paid", Declined: "failed", Expired: "expired", Refunded: "refunded", Voided: "refunded" };
const MONO_STATUS: Record<string, PaymentStatus> = { success: "paid", failure: "failed", expired: "expired", reversed: "refunded" };

/** Статус оплаты у банка (null — ещё не оплачено / не удалось узнать). */
export async function statusAtBank(p: Payment, cfg: ClientPayments): Promise<PaymentStatus | null> {
  const c = cfg.credentials;
  if (p.provider === "liqpay") {
    const data = Buffer.from(JSON.stringify({ action: "status", version: 3, public_key: c.publicKey, order_id: p.orderId })).toString("base64");
    const res = await fetch(`${LIQPAY()}/api/request`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data, signature: liqSign(c.privateKey ?? "", data) }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { status?: string };
    return LIQ_STATUS[j.status ?? ""] ?? null;
  }
  if (p.provider === "wayforpay") {
    const res = await fetch(`${WAYFORPAY()}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactionType: "CHECK_STATUS", merchantAccount: c.merchant, orderReference: p.orderId, apiVersion: 1, merchantSignature: md5(c.secret ?? "", [c.merchant ?? "", p.orderId]) }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { transactionStatus?: string };
    return WFP_STATUS[j.transactionStatus ?? ""] ?? null;
  }
  if (!p.externalId) return null;
  const res = await fetch(`${MONOBANK()}/api/merchant/invoice/status?invoiceId=${encodeURIComponent(p.externalId)}`, { headers: { "X-Token": c.token ?? "" }, signal: AbortSignal.timeout(15_000) });
  const j = (await res.json().catch(() => ({}))) as { status?: string; reference?: string };
  if (j.reference && j.reference !== p.orderId) return null;
  return MONO_STATUS[j.status ?? ""] ?? null;
}

const PAID_TEXT: Record<"ru" | "uk" | "en", string> = {
  ru: "✅ Оплату {amount} получили — спасибо! Если нужно что-то ещё, просто напишите.",
  uk: "✅ Оплату {amount} отримали — дякуємо! Якщо потрібно ще щось, просто напишіть.",
  en: "✅ We've received your payment of {amount} — thank you! Write if you need anything else.",
};

/** Новый статус оплаты: запись, отметка в разговоре, подтверждение клиенту, уведомления и событие. */
export async function applyStatus(p: Payment, status: PaymentStatus): Promise<boolean> {
  if (p.status === status || (p.status === "paid" && status !== "refunded")) return false;
  const updated = await db
    .update(payments)
    .set({ status, ...(status === "paid" ? { paidAt: new Date() } : {}) })
    .where(and(eq(payments.id, p.id), eq(payments.status, p.status)))
    .returning();
  if (!updated.length) return false;
  const amount = `${p.amount} ${p.currency}`;
  const { addMessage, deliver } = await import("@/lib/conversations");
  if (p.conversationId) {
    const label = status === "paid" ? "💳 Оплачено" : status === "refunded" ? "↩️ Возврат" : status === "expired" ? "⌛ Ссылка истекла" : "⚠️ Оплата не прошла";
    await addMessage(p.conversationId, "system", `${label}: ${amount} · ${p.description}`).catch(() => {});
    if (status === "paid") {
      const [r] = await db
        .select({ conversation: conversations, channel: channels, config: agents.config })
        .from(conversations)
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .innerJoin(agents, eq(agents.id, conversations.agentId))
        .where(eq(conversations.id, p.conversationId));
      if (r) {
        const cfg = await getPayments(p.clientId);
        const { disclosureLanguage } = await import("@/lib/agent/disclosure");
        const lang = disclosureLanguage(r.conversation.context?.language, r.config.replyLanguage);
        const text = (cfg?.paidText.trim() || PAID_TEXT[lang]).replaceAll("{amount}", amount);
        try {
          const externalId = await deliver(r.channel, r.conversation, text);
          await addMessage(p.conversationId, "assistant", text, { externalId: externalId ?? undefined });
        } catch (e) {
          console.error("payment confirmation failed", e instanceof Error ? e.message : e);
        }
      }
    }
  }
  if (status !== "expired") {
    const { notifyPayment } = await import("@/lib/notify/telegram");
    await notifyPayment({ clientId: p.clientId, conversationId: p.conversationId, amount: p.amount, currency: p.currency, description: p.description, status });
    const { emitEvent } = await import("@/lib/integrations/events");
    void emitEvent("payment", {
      clientId: p.clientId,
      agentId: p.agentId,
      conversationId: p.conversationId,
      payment: { amount: p.amount, currency: p.currency, description: p.description, status, provider: p.provider, orderId: p.orderId },
    });
  }
  return true;
}

/** Перепроверить у банка и применить. */
export async function refreshPayment(p: Payment): Promise<PaymentStatus> {
  const cfg = await getPayments(p.clientId);
  if (!cfg || cfg.provider !== p.provider || !credentialsReady(cfg)) return p.status;
  const s = await statusAtBank(p, cfg).catch(() => null);
  if (s && (await applyStatus(p, s))) return s;
  return p.status;
}

/**
 * Уведомление банка. Подпись проверяется (LiqPay, WayForPay); у Monobank статус перепроверяется у банка по номеру
 * счёта. Возвращает тело ответа банку.
 */
export async function handleCallback(provider: PayProvider, clientId: string, raw: string, contentType: string): Promise<{ status: number; body: string }> {
  const cfg = await getPayments(clientId);
  if (!cfg || cfg.provider !== provider) return { status: 404, body: "unknown" };
  const c = cfg.credentials;
  const find = async (orderId: string) => (await db.select().from(payments).where(and(eq(payments.orderId, orderId), eq(payments.clientId, clientId))))[0];

  if (provider === "liqpay") {
    const f = new URLSearchParams(raw);
    const data = f.get("data") ?? "";
    if (!data || liqSign(c.privateKey ?? "", data) !== f.get("signature")) return { status: 403, body: "bad signature" };
    const j = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { order_id?: string; status?: string };
    const p = j.order_id ? await find(j.order_id) : undefined;
    const s = LIQ_STATUS[j.status ?? ""];
    if (p && s) await applyStatus(p, s);
    return { status: 200, body: "ok" };
  }

  if (provider === "wayforpay") {
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(raw);
    } catch {
      // Иногда приходит формой, где весь JSON — имя поля
      const first = [...new URLSearchParams(raw).keys()][0];
      j = first ? JSON.parse(first) : {};
    }
    const fields = ["merchantAccount", "orderReference", "amount", "currency", "authCode", "cardPan", "transactionStatus", "reasonCode"].map((k) => String(j[k] ?? ""));
    if (j.merchantAccount !== c.merchant || md5(c.secret ?? "", fields) !== j.merchantSignature) return { status: 403, body: "bad signature" };
    const orderId = String(j.orderReference);
    const p = await find(orderId);
    const s = WFP_STATUS[String(j.transactionStatus)];
    if (p && s) await applyStatus(p, s);
    const time = Math.floor(Date.now() / 1000);
    return { status: 200, body: JSON.stringify({ orderReference: orderId, status: "accept", time, signature: md5(c.secret ?? "", [orderId, "accept", time]) }) };
  }

  void contentType;
  const j = JSON.parse(raw || "{}") as { invoiceId?: string; reference?: string };
  const p = j.reference ? await find(j.reference) : undefined;
  if (p && p.externalId === j.invoiceId) await refreshPayment(p);
  return { status: 200, body: "ok" };
}

export const paymentsNote = [
  "# Оплата",
  "Ты можешь выставить клиенту ссылку на оплату инструментом create_payment_link. Сумма — только из прайса, расчёта calc_quote, базы знаний или подтверждённая менеджером; не придумывай и не округляй её. Перед ссылкой коротко назови, за что и сколько. Ссылку вставляй как есть.",
  "Если клиент пишет, что оплатил, — проверь инструментом check_payment и скажи результат. Не подтверждай оплату, пока банк её не подтвердил.",
].join("\n");

/** Инструменты агента: ссылка на оплату и проверка оплаты в этом разговоре. */
export function paymentTools(cfg: ClientPayments, ctx: ToolContext): AgentTool[] {
  return [
    {
      name: "create_payment_link",
      description: `Create a payment link for the customer (${cfg.currency}). Amount must come from the price list, calc_quote result, knowledge base or the manager — never guess. Returns the link to send to the customer as is.`,
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number", description: `Amount in ${cfg.currency}` }, description: { type: "string", description: "What is being paid for (shown on the bank page), short" } },
        required: ["amount", "description"],
      },
      parse: z.object({ amount: z.number().positive().max(10_000_000), description: z.string().trim().min(1).max(200) }),
      run: async (input) => {
        const { amount, description } = input as { amount: number; description: string };
        if (cfg.maxAmount != null && amount > cfg.maxAmount) return `Amount is above the limit ${cfg.maxAmount} ${cfg.currency} — do not send a link, hand the customer over to a manager.`;
        if (ctx.mode === "dry") return `[Test chat: a real link is not created] Payment link for ${amount} ${cfg.currency} (${description}): https://pay.example/test`;
        const r = await createPayment(ctx.clientId, { amount, description, conversationId: ctx.conversationId, agentId: ctx.agentId }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }) as { error: string; link?: string });
        if (!r.link) return `Payment link could not be created (${r.error}). Tell the customer a manager will send payment details, and hand over.`;
        return `Payment link for ${money(amount)} ${cfg.currency} (${description}): ${r.link}`;
      },
    },
    {
      name: "check_payment",
      description: "Check whether the customer has paid by the links sent in this conversation (asks the bank). Use when the customer says they paid.",
      inputSchema: { type: "object", properties: {} },
      parse: z.object({}).passthrough(),
      run: async () => {
        if (!ctx.conversationId || ctx.mode === "dry") return "No payment links in this conversation.";
        const list = await db.select().from(payments).where(eq(payments.conversationId, ctx.conversationId)).orderBy(desc(payments.createdAt)).limit(5);
        if (!list.length) return "No payment links in this conversation.";
        const lines: string[] = [];
        for (const p of list) {
          const s = p.status === "created" ? await refreshPayment(p) : p.status;
          lines.push(`${p.amount} ${p.currency} · ${p.description} · ${s === "created" ? "not paid yet" : s}`);
        }
        return lines.join("\n");
      },
    },
  ];
}
