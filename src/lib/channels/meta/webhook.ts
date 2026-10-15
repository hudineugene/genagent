import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getMetaSettings } from "@/lib/settings";

/** Подтверждение адреса вебхука: Meta присылает GET с hub.challenge — возвращаем его, если маркер совпал. */
export async function verifyChallenge(req: Request) {
  const u = new URL(req.url);
  const { verifyToken } = await getMetaSettings();
  if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === verifyToken) {
    return new Response(u.searchParams.get("hub.challenge") ?? "", { headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

/** Подпись X-Hub-Signature-256 = HMAC-SHA256(тело, секрет приложения). */
export function validSignature(raw: string, header: string | null, appSecret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw, "utf8").digest("hex");
  const got = header.slice(7);
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** signed_request из запросов отмены доступа / удаления данных: «подпись.данные» (base64url). */
export function parseSignedRequest(signed: string, appSecret: string): { user_id?: string } | null {
  const [sig, payload] = signed.split(".");
  if (!sig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
