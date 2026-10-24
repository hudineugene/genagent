import { PAY_PROVIDERS, type PayProvider } from "@/db/schema";
import { handleCallback } from "@/lib/payments";

/** Уведомление банка об оплате (LiqPay server_url, WayForPay serviceUrl, Monobank webHookUrl). */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string; clientId: string }> }) {
  const { provider, clientId } = await params;
  if (!(PAY_PROVIDERS as readonly string[]).includes(provider)) return new Response("Not found", { status: 404 });
  const raw = (await req.text()).slice(0, 100_000);
  try {
    const r = await handleCallback(provider as PayProvider, clientId, raw, req.headers.get("content-type") ?? "");
    return new Response(r.body, { status: r.status, headers: { "content-type": r.body.startsWith("{") ? "application/json" : "text/plain" } });
  } catch (e) {
    console.error("payment callback failed", provider, e instanceof Error ? e.message : e);
    return new Response("error", { status: 400 });
  }
}
