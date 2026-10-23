import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { loyaltyAccounts } from "@/db/schema";
import { adjust, ensureAccount, getProgram, normContact } from "@/lib/loyalty/engine";

/**
 * Баллы из CRM, сайта или кассы. Заголовок Authorization: Bearer <ключ программы>.
 * GET ?contact=… — баланс; POST {contact, name?, delta, reason?} — начислить (delta > 0) или списать (delta < 0).
 * contact — @ник Telegram, id Telegram, телефон или почта (тот же, по которому клиент пишет агенту).
 */
async function auth(req: Request, programId: string) {
  const p = await getProgram(programId);
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(p?.apiKey ?? "");
  if (!p || !p.enabled || got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return p;
}

export async function GET(req: Request, { params }: { params: Promise<{ programId: string }> }) {
  const p = await auth(req, (await params).programId);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  const contact = normContact(new URL(req.url).searchParams.get("contact") ?? "");
  if (!contact) return Response.json({ error: "no_contact" }, { status: 400 });
  const [a] = await db.select().from(loyaltyAccounts).where(and(eq(loyaltyAccounts.programId, p.id), eq(loyaltyAccounts.contact, contact)));
  return Response.json({ contact, balance: a?.balance ?? 0, exists: Boolean(a) });
}

const body = z.object({
  contact: z.string().trim().min(1).max(200),
  name: z.string().trim().max(100).optional(),
  delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0),
  reason: z.string().trim().max(300).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ programId: string }> }) {
  const p = await auth(req, (await params).programId);
  if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid", details: parsed.error.issues.map((i) => i.path.join(".")) }, { status: 400 });
  const d = parsed.data;
  const contact = normContact(d.contact);
  if (!contact) return Response.json({ error: "no_contact" }, { status: 400 });
  const { account } = await ensureAccount(p, [contact], { name: d.name });
  const r = await adjust(p, account, d.delta, d.reason ?? "", "api");
  if ("error" in r) return Response.json({ error: r.error, balance: account.balance }, { status: 409 });
  return Response.json({ contact, balance: r.account.balance });
}
