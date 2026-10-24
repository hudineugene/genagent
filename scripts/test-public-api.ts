/** Открытый API студии: без ключа и с чужим ключом — 401; ключ одного клиента видит только его (клиенты, агенты,
 *  разговоры, расходы), чужой разговор — 404; запись клиенту — только ключом с правом write, сообщение уходит
 *  от сотрудника; отозванный ключ — 401; хранится только хэш.  DB_PATH=<копия caltest> npx tsx scripts/test-public-api.ts */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, apiKeys, channels, clients, conversations, messages } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  const { newApiKey } = await import("@/lib/public-api");
  const [agent] = await db.select().from(agents).limit(1);
  const [a] = await db.insert(clients).values({ name: "API A" }).returning();
  const [b] = await db.insert(clients).values({ name: "API B" }).returning();
  const { id: _x, ...rest } = agent;
  void _x;
  const mkConv = async (clientId: string, ext: string) => {
    const [ag] = await db.insert(agents).values({ ...rest, clientId, name: `api-${ext}` }).returning();
    const [ch] = await db.insert(channels).values({ agentId: ag.id, clientId, type: "widget", name: "w", config: {} as never }).returning();
    const [conv] = await db.insert(conversations).values({ clientId, agentId: ag.id, channelId: ch.id, channelType: "widget", externalId: ext, contactName: "Клиент" }).returning();
    await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "Здравствуйте" } as never);
    return { ag, conv };
  };
  const A = await mkConv(a.id, "api-a");
  const B = await mkConv(b.id, "api-b");
  const keyFor = async (scope: "read" | "write", clientIds: string[] | null) => {
    const k = newApiKey();
    await db.insert(apiKeys).values({ name: "t", prefix: k.prefix, keyHash: k.hash, scope, clientIds });
    return k.key;
  };
  const readA = await keyFor("read", [a.id]);
  const writeA = await keyFor("write", [a.id]);
  const call = async (mod: string, key: string | null, url: string, params?: object, init?: RequestInit) => {
    const m = await import(mod);
    const fn = init?.method === "POST" ? m.POST : m.GET;
    const res: Response = await fn(new Request(`https://x${url}`, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" } }), params ? { params: Promise.resolve(params) } : undefined);
    return { status: res.status, body: await res.json() };
  };
  const noKey = await call("@/app/api/v1/clients/route", null, "/api/v1/clients");
  const badKey = await call("@/app/api/v1/clients/route", "ga_live_nope", "/api/v1/clients");
  const cl = await call("@/app/api/v1/clients/route", readA, "/api/v1/clients");
  const ags = await call("@/app/api/v1/agents/route", readA, "/api/v1/agents");
  const agsB = await call("@/app/api/v1/agents/route", readA, `/api/v1/agents?client_id=${b.id}`);
  const convs = await call("@/app/api/v1/conversations/route", readA, "/api/v1/conversations?limit=500");
  const one = await call("@/app/api/v1/conversations/[id]/route", readA, `/api/v1/conversations/${A.conv.id}`, { id: A.conv.id });
  const other = await call("@/app/api/v1/conversations/[id]/route", readA, `/api/v1/conversations/${B.conv.id}`, { id: B.conv.id });
  const post = { method: "POST", body: JSON.stringify({ text: "Добрый день, это менеджер" }) };
  const postRead = await call("@/app/api/v1/conversations/[id]/messages/route", readA, `/api/v1/conversations/${A.conv.id}/messages`, { id: A.conv.id }, post);
  const postWrite = await call("@/app/api/v1/conversations/[id]/messages/route", writeA, `/api/v1/conversations/${A.conv.id}/messages`, { id: A.conv.id }, post);
  const postOther = await call("@/app/api/v1/conversations/[id]/messages/route", writeA, `/api/v1/conversations/${B.conv.id}/messages`, { id: B.conv.id }, post);
  const usage = await call("@/app/api/v1/usage/route", readA, "/api/v1/usage");
  const sent = (await db.select().from(messages).where(eq(messages.conversationId, A.conv.id)).orderBy(asc(messages.createdAt))).find((m) => m.role === "operator");
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.keyHash, (await import("@/lib/public-api")).hashKey(readA)));
  const revoked = await call("@/app/api/v1/clients/route", readA, "/api/v1/clients");
  const stored = await db.select().from(apiKeys);

  await db.delete(apiKeys);
  for (const c of [a, b]) await db.delete(clients).where(eq(clients.id, c.id));
  for (const x of [A, B]) await db.delete(agents).where(eq(agents.id, x.ag.id));

  const r: Record<string, boolean> = {
    "без ключа и с неверным ключом — 401": noKey.status === 401 && badKey.status === 401,
    "ключ клиента видит только своего клиента и его агентов": cl.body.data.length === 1 && cl.body.data[0].id === a.id && ags.body.data.every((x: { client_id: string }) => x.client_id === a.id) && agsB.status === 403,
    "разговоры — только свои, с сообщениями; чужой — 404": convs.body.data.every((x: { client_id: string }) => x.client_id === a.id) && convs.body.data.some((x: { id: string }) => x.id === A.conv.id) && one.body.messages[0].role === "customer" && other.status === 404,
    "запись: ключ чтения — 403, ключ записи — сообщение от сотрудника; в чужой — 404": postRead.status === 403 && postWrite.status === 201 && sent?.text === "Добрый день, это менеджер" && postOther.status === 404,
    "расходы — только свои клиенты": usage.body.data.length === 1 && usage.body.data[0].client_id === a.id,
    "отозванный ключ — 401; в базе только хэш": revoked.status === 401 && stored.every((k) => !k.keyHash.startsWith("ga_live_") && k.keyHash.length === 64),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
