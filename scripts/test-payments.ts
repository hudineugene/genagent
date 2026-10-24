/** Оплата в диалоге: ссылка LiqPay (подпись), WayForPay (счёт), Monobank (счёт); уведомление банка с верной подписью —
 *  «оплачено», подтверждение клиенту в чат и отметка в разговоре; поддельная подпись — отказ; проверка оплаты
 *  агентом (Monobank — статус у банка); лимит суммы; короткая ссылка ведёт на страницу банка; тест-чат ссылок
 *  не создаёт. Банки и Telegram — заглушки.  DB_PATH=<копия caltest> npx tsx scripts/test-payments.ts */
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientPayments, clients, conversations, messages, payments } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const calls: { path: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
  let monoRef = "";
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      calls.push({ path: url, body, headers: req.headers });
      const json = (o: object) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url === "/api" && body.includes("CREATE_INVOICE")) return json({ reasonCode: 1100, reason: "Ok", invoiceUrl: "https://secure.wayforpay.com/invoice/abc" });
      if (url === "/api" && body.includes("CHECK_STATUS")) return json({ transactionStatus: "Approved" });
      if (url === "/api/merchant/invoice/create") {
        monoRef = JSON.parse(body).merchantPaymInfo.reference;
        return json({ invoiceId: "inv-1", pageUrl: "https://pay.mbnk.biz/inv-1" });
      }
      if (url.startsWith("/api/merchant/invoice/status")) return json({ invoiceId: "inv-1", status: "success", reference: monoRef });
      if (url === "/api/request") return json({ status: "success" });
      return json({ ok: true, result: { message_id: 1 } });
    });
  });
  await new Promise<void>((r) => stub.listen(4077, r));
  for (const k of ["LIQPAY_URL", "WAYFORPAY_URL", "MONOBANK_URL", "TELEGRAM_API_URL"]) process.env[k] = "http://127.0.0.1:4077";
  process.env.PUBLIC_URL = "https://agents.test";

  const [agent] = await db.select().from(agents).limit(1);
  const [c] = await db.insert(clients).values({ name: "Pay Test" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [a] = await db.insert(agents).values({ ...rest, clientId: c.id, name: "pay-agent" }).returning();
  const [ch] = await db.insert(channels).values({ agentId: a.id, clientId: c.id, type: "widget", name: "w", config: {} as never }).returning();
  const [conv] = await db.insert(conversations).values({ clientId: c.id, agentId: a.id, channelId: ch.id, channelType: "widget", externalId: crypto.randomUUID(), contactName: "Покупатель" }).returning();

  const pay = await import("@/lib/payments");
  const { handleCallback, paymentTools, getPayments } = pay;
  const setCfg = async (provider: "liqpay" | "wayforpay" | "monobank", credentials: object, maxAmount: number | null = 5000) => {
    await db.delete(clientPayments).where(eq(clientPayments.clientId, c.id));
    await db.insert(clientPayments).values({ clientId: c.id, provider, credentials, currency: "UAH", maxAmount, enabled: true });
    return (await getPayments(c.id))!;
  };
  const tools = async (cfg: Awaited<ReturnType<typeof setCfg>>, mode: "live" | "dry" = "live") => {
    const [link, check] = paymentTools(cfg, { mode, clientId: c.id, conversationId: conv.id, agentId: a.id });
    return { link: (i: object) => link.run(i) as Promise<string>, check: () => check.run({}) as Promise<string> };
  };
  const last = async () => (await db.select().from(payments).where(eq(payments.clientId, c.id)).orderBy(asc(payments.createdAt))).at(-1)!;
  const r: Record<string, boolean> = {};

  // LiqPay: ссылка с подписью, уведомление банка
  let cfg = await setCfg("liqpay", { publicKey: "pub", privateKey: "priv" });
  let t = await tools(cfg);
  const out1 = await t.link({ amount: 450, description: "Заказ №12" });
  let p = await last();
  const data = new URL(p.url).searchParams.get("data")!;
  const sig = new URL(p.url).searchParams.get("signature")!;
  const decoded = JSON.parse(Buffer.from(data, "base64").toString());
  r["LiqPay: ссылка с верной подписью и адресом уведомлений"] =
    out1.includes("https://agents.test/api/webhooks/pay/go/") &&
    sig === createHash("sha1").update(`priv${data}priv`).digest("base64") &&
    decoded.amount === 450 && decoded.server_url === `https://agents.test/api/webhooks/pay/liqpay/${c.id}`;
  const same = await t.link({ amount: 450, description: "Заказ №12" });
  r["повторная просьба — та же ссылка, не новый счёт"] = same === out1 && (await db.select().from(payments).where(eq(payments.clientId, c.id))).length === 1;
  const cbData = Buffer.from(JSON.stringify({ order_id: p.orderId, status: "success" })).toString("base64");
  const fake = await handleCallback("liqpay", c.id, new URLSearchParams({ data: cbData, signature: "bad" }).toString(), "application/x-www-form-urlencoded");
  const good = await handleCallback("liqpay", c.id, new URLSearchParams({ data: cbData, signature: createHash("sha1").update(`priv${cbData}priv`).digest("base64") }).toString(), "application/x-www-form-urlencoded");
  p = await last();
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));
  r["поддельная подпись — отказ, верная — «оплачено»"] = fake.status === 403 && good.status === 200 && p.status === "paid" && Boolean(p.paidAt);
  r["клиенту — подтверждение, в разговоре — отметка"] = msgs.some((m) => m.role === "assistant" && m.text.includes("450 UAH") && m.text.startsWith("✅")) && msgs.some((m) => m.role === "system" && m.text.startsWith("💳 Оплачено"));
  const again = await handleCallback("liqpay", c.id, new URLSearchParams({ data: cbData, signature: createHash("sha1").update(`priv${cbData}priv`).digest("base64") }).toString(), "");
  r["повторное уведомление банка — без второго подтверждения"] =
    again.status === 200 && (await db.select().from(messages).where(eq(messages.conversationId, conv.id))).filter((m) => m.role === "assistant").length === 1;
  const { GET } = await import("@/app/api/webhooks/pay/go/[orderId]/route");
  const paidPage = await GET(new Request("http://x"), { params: Promise.resolve({ orderId: p.orderId }) });

  // WayForPay: счёт через API, подпись, ответ банку
  cfg = await setCfg("wayforpay", { merchant: "shop_ua", secret: "sek", domain: "shop.ua" });
  t = await tools(cfg);
  const out2 = await t.link({ amount: 1200, description: "Курс" });
  p = await last();
  const inv = JSON.parse(calls.find((x) => x.body.includes("CREATE_INVOICE"))!.body);
  const hm = (parts: (string | number)[]) => createHmac("md5", "sek").update(parts.join(";")).digest("hex");
  const go = await GET(new Request("http://x"), { params: Promise.resolve({ orderId: p.orderId }) });
  r["WayForPay: счёт с верной подписью, короткая ссылка ведёт на банк"] =
    out2.includes("/pay/go/") && inv.merchantSignature === hm(["shop_ua", "shop.ua", p.orderId, inv.orderDate, 1200, "UAH", "Курс", 1, 1200]) && go.status === 302 && go.headers.get("location") === "https://secure.wayforpay.com/invoice/abc" && paidPage.status === 200;
  const cb = { merchantAccount: "shop_ua", orderReference: p.orderId, amount: 1200, currency: "UAH", authCode: "1", cardPan: "41****11", transactionStatus: "Approved", reasonCode: 1100 };
  const signed = { ...cb, merchantSignature: hm(Object.values(cb)) };
  const wr = await handleCallback("wayforpay", c.id, JSON.stringify(signed), "application/json");
  const ans = JSON.parse(wr.body);
  r["WayForPay: уведомление принято, ответ банку подписан"] = (await last()).status === "paid" && ans.status === "accept" && ans.signature === hm([p.orderId, "accept", ans.time]);

  // Monobank: счёт, проверка оплаты агентом по запросу к банку
  cfg = await setCfg("monobank", { token: "tok" }, 1000);
  t = await tools(cfg);
  const tooMuch = await t.link({ amount: 5000, description: "Большой заказ" });
  const out3 = await t.link({ amount: 300, description: "Доставка" });
  p = await last();
  const create = calls.find((x) => x.path === "/api/merchant/invoice/create")!;
  const checked = await t.check();
  r["Monobank: сумма в копейках, токен в заголовке; сверх лимита — без ссылки"] =
    tooMuch.includes("above the limit") && out3.includes("/pay/go/") && JSON.parse(create.body).amount === 30000 && create.headers["x-token"] === "tok" && p.externalId === "inv-1";
  r["проверка оплаты агентом — статус у банка"] = checked.includes("300 UAH · Доставка · paid") && (await last()).status === "paid";

  // Тест-чат: настоящих ссылок нет
  const before = (await db.select().from(payments).where(eq(payments.clientId, c.id))).length;
  const dry = await (await tools(cfg, "dry")).link({ amount: 100, description: "x" });
  r["тест-чат ссылок не создаёт"] = dry.includes("Test chat") && (await db.select().from(payments).where(eq(payments.clientId, c.id))).length === before;

  await db.delete(clients).where(eq(clients.id, c.id));
  await db.delete(agents).where(eq(agents.id, a.id));
  stub.close();
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
