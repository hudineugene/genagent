/** Двухфакторный вход и доступ сотрудников: коды TOTP (пример из RFC 6238), допуск ±30 с, секрет хранится
 *  зашифрованным, коды восстановления одноразовые; сотрудник со списком клиентов видит только их, запись любого
 *  модуля определяется по клиенту (агент, канал, разговор, сообщение, урок, сценарий теста…).
 *  DB_PATH=<копия caltest> npx tsx scripts/test-access.ts */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clients, conversations, courses, lessons, messages, testScenarios } from "@/db/schema";

(async () => {
  if (!process.env.DB_PATH?.includes("caltest")) throw new Error("Только на тестовой копии базы (DB_PATH)");
  process.env.SESSION_PASSWORD ||= "x".repeat(40);
  const totp = await import("@/lib/totp");
  const access = await import("@/lib/access");

  const rfc = totp.base32Encode(Buffer.from("12345678901234567890"));
  const secret = totp.newSecret();
  const now = Date.now();
  const sealed = totp.sealSecret(secret);
  const { codes, hashes } = totp.newRecoveryCodes();
  const left = totp.consumeRecoveryCode(hashes, codes[3].toLowerCase());

  const [agent] = await db.select().from(agents).limit(1);
  const [a] = await db.insert(clients).values({ name: "Access A" }).returning();
  const [b] = await db.insert(clients).values({ name: "Access B" }).returning();
  const { id: _a, ...rest } = agent;
  void _a;
  const [ag] = await db.insert(agents).values({ ...rest, clientId: b.id, name: "b-agent" }).returning();
  const [ch] = await db.insert(channels).values({ agentId: ag.id, clientId: b.id, type: "widget", name: "w", config: {} as never }).returning();
  const [conv] = await db.insert(conversations).values({ clientId: b.id, agentId: ag.id, channelId: ch.id, channelType: "widget", externalId: "acc-1", contactName: "X" }).returning();
  const [msg] = await db.insert(messages).values({ conversationId: conv.id, role: "user", text: "hi" }).returning();
  const [course] = await db.insert(courses).values({ clientId: b.id, title: "C" } as never).returning();
  const [lesson] = await db.insert(lessons).values({ courseId: course.id, title: "L", body: "" } as never).returning();
  const [sc] = await db.insert(testScenarios).values({ agentId: ag.id, name: "s", turns: [], criteria: [] } as never).returning();
  const owners = await Promise.all([
    access.clientOf("agent", ag.id),
    access.clientOf("channel", ch.id),
    access.clientOf("conversation", conv.id),
    access.clientOf("message", msg.id),
    access.clientOf("course", course.id),
    access.clientOf("lesson", lesson.id),
    access.clientOf("scenario", sc.id),
  ]);
  const member = { role: "member" as const, clientIds: [a.id] };
  await db.delete(clients).where(eq(clients.id, a.id));
  await db.delete(clients).where(eq(clients.id, b.id));
  await db.delete(agents).where(eq(agents.id, ag.id));

  const r: Record<string, boolean> = {
    "TOTP: пример RFC 6238 (59 с → 287082)": totp.totpCode(rfc, 59_000) === "287082" && totp.totpCode(rfc, 1111111109_000) === "081804",
    "код подходит сейчас и ±30 с, через 2 минуты — нет": totp.verifyTotp(secret, totp.totpCode(secret, now), now) && totp.verifyTotp(secret, totp.totpCode(secret, now - 30_000), now) && !totp.verifyTotp(secret, totp.totpCode(secret, now - 120_000), now) && !totp.verifyTotp(secret, "12345", now),
    "секрет хранится зашифрованным и расшифровывается": !sealed.includes(secret) && totp.openSecret(sealed) === secret,
    "код восстановления — один раз": codes.length === 8 && left?.length === 7 && totp.consumeRecoveryCode(left, codes[3]) === null,
    "QR-ссылка для приложения": totp.otpauthUri(secret, "a@b.c").startsWith("otpauth://totp/GenAgent%3Aa%40b.c?secret="),
    "администратор и сотрудник без списка — все клиенты": access.scopeOf({ role: "admin", clientIds: [a.id] }) === null && access.scopeOf({ role: "member", clientIds: null }) === null,
    "сотрудник со списком — только свои": access.canClient(member, a.id) && !access.canClient(member, b.id) && !access.canClient({ role: "member", clientIds: [] }, a.id),
    "клиент любой записи определяется": owners.every((o) => o === b.id),
  };
  console.log(r);
  process.exit(Object.values(r).every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
