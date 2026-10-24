import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, type ApiKey } from "@/db/schema";

/**
 * Открытый API студии (/api/v1): ключ в заголовке Authorization: Bearer ga_live_…, хранится только его хэш.
 * Права: read — читать клиентов, агентов, разговоры, расходы; write — ещё и писать клиенту от имени сотрудника.
 * Ключ можно ограничить клиентами. Ответы — JSON, ошибки — { error } с кодом HTTP; не больше 120 запросов в минуту.
 */
export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");

export function newApiKey() {
  const key = `ga_live_${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

const RATE = 120;
const g = globalThis as unknown as { __apiRate?: Map<string, { n: number; at: number }> };
const rate = (g.__apiRate ??= new Map());

export type ApiAuth = { key: ApiKey; can: (clientId: string | null | undefined) => boolean };

export const fail = (status: number, error: string) => Response.json({ error }, { status });

/** Проверить ключ запроса. Ответ-ошибка или авторизация. */
export async function authorize(req: Request, need: "read" | "write" = "read"): Promise<ApiAuth | Response> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token.startsWith("ga_live_")) return fail(401, "missing_or_invalid_key");
  const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.keyHash, hashKey(token)), isNull(apiKeys.revokedAt)));
  if (!key) return fail(401, "invalid_key");
  if (need === "write" && key.scope !== "write") return fail(403, "read_only_key");
  const now = Date.now();
  const r = rate.get(key.id);
  if (r && now - r.at < 60_000) {
    if (++r.n > RATE) return fail(429, "rate_limited");
  } else rate.set(key.id, { n: 1, at: now });
  if (!key.lastUsedAt || now - key.lastUsedAt.getTime() > 60_000) void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
  return { key, can: (clientId) => !key.clientIds || (Boolean(clientId) && key.clientIds.includes(clientId!)) };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
