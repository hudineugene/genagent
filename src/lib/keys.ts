import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, clients, conversations } from "@/db/schema";

/**
 * Свои ключи клиента (Anthropic, OpenAI, OpenRouter, Google Maps). Всё, что делается для клиента — ответы агента,
 * проверки, контент, встречи, данные, маршруты, — выполняется «в области» клиента: модели берут ключ клиента,
 * а если его нет — ключ студии (secrets.env или «Внешние сервисы»). Расход за счёт клиента помечается в учёте.
 */
export type KeyKind = "anthropic" | "openai" | "openrouter" | "googleMaps";
export type ClientKeys = Partial<Record<KeyKind, string>>;
export const KEY_KINDS: KeyKind[] = ["anthropic", "openai", "openrouter", "googleMaps"];
const ENV: Record<KeyKind, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY", googleMaps: "GOOGLE_MAPS_API_KEY" };

type Scope = { clientId: string; keys: ClientKeys };
const g = globalThis as unknown as { __keysAls?: AsyncLocalStorage<Scope>; __keysCache?: Map<string, { keys: ClientKeys; at: number }> };
const als = (g.__keysAls ??= new AsyncLocalStorage<Scope>());
const cache = (g.__keysCache ??= new Map());
const TTL_MS = 60_000;

/** Ключ клиента в текущей области (если задан). */
export function scopedKey(kind: KeyKind): string | undefined {
  return als.getStore()?.keys[kind] || undefined;
}

/** Ключ для вызова: клиента в текущей области, иначе студии. */
export function apiKey(kind: KeyKind): string | undefined {
  return scopedKey(kind) || process.env[ENV[kind]] || undefined;
}

/** Вызов идёт за счёт клиента (его ключ задан в текущей области). */
export function usingClientKey(kind: KeyKind) {
  return Boolean(scopedKey(kind));
}

export async function clientKeys(clientId: string): Promise<ClientKeys> {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.keys;
  const [row] = await db.select({ keys: clients.apiKeys }).from(clients).where(eq(clients.id, clientId));
  const keys = row?.keys ?? {};
  cache.set(clientId, { keys, at: Date.now() });
  return keys;
}

export function forgetClientKeys(clientId: string) {
  cache.delete(clientId);
}

/** Есть ли ключ для клиента — его или студии (для подсказок в интерфейсе). */
export async function hasKey(clientId: string, kind: KeyKind) {
  return Boolean((await clientKeys(clientId))[kind] || process.env[ENV[kind]]);
}

type Owner = { clientId?: string | null; agentId?: string | null; conversationId?: string | null };

async function resolveClient(o: Owner): Promise<string | null> {
  if (o.clientId) return o.clientId;
  if (o.conversationId) {
    const [r] = await db.select({ id: conversations.clientId }).from(conversations).where(eq(conversations.id, o.conversationId));
    if (r) return r.id;
  }
  if (o.agentId) {
    const [r] = await db.select({ id: agents.clientId }).from(agents).where(eq(agents.id, o.agentId));
    if (r) return r.id;
  }
  return null;
}

/** Выполнить работу для клиента: внутри модели берут его ключи. Уже в области этого клиента — без повторного поиска. */
export async function withKeys<T>(owner: Owner, fn: () => Promise<T>): Promise<T> {
  const cur = als.getStore();
  if (cur && owner.clientId && cur.clientId === owner.clientId) return fn();
  const clientId = await resolveClient(owner).catch(() => null);
  if (!clientId) return fn();
  if (cur?.clientId === clientId) return fn();
  const keys = await clientKeys(clientId).catch(() => ({}));
  return als.run({ clientId, keys }, fn);
}

/** Как ключ показать в интерфейсе: только начало и последние 4 символа. */
export function maskKey(key: string) {
  return key.length <= 12 ? "••••" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
