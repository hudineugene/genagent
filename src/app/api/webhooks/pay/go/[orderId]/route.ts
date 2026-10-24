import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments } from "@/db/schema";

/** Короткая ссылка на оплату из чата → страница оплаты банка (номер заказа неугадываемый). */
export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const [p] = await db.select({ url: payments.url, status: payments.status }).from(payments).where(eq(payments.orderId, orderId));
  if (!p) return new Response("Ссылка на оплату не найдена", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (p.status === "paid") return new Response("✅ Этот счёт уже оплачен. Спасибо!", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.redirect(p.url, 302);
}
