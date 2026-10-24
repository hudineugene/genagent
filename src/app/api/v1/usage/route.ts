import { bills, currentMonth } from "@/lib/billing";
import { authorize, fail } from "@/lib/public-api";

/** GET /api/v1/usage?month=YYYY-MM&client_id= — расходы за месяц по клиентам (себестоимость, USD; без маржи). */
export async function GET(req: Request) {
  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const sp = new URL(req.url).searchParams;
  const month = sp.get("month") ?? currentMonth();
  if (!/^\d{4}-\d{2}$/.test(month)) return fail(400, "bad_month");
  const clientId = sp.get("client_id") ?? undefined;
  if (clientId && !auth.can(clientId)) return fail(403, "client_not_allowed");
  const list = (await bills(month, clientId)).filter((b) => auth.can(b.clientId));
  return Response.json({ month, data: list.map((b) => ({ client_id: b.clientId, client: b.client, ai_usd: b.aiCost, ai_own_keys_usd: b.aiOwnKey, channels_usd: b.channelCost })) });
}
