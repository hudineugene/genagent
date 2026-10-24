import "server-only";
import { cookies } from "next/headers";
import { sealData, unsealData } from "iron-session";

/** pending — пароль верный, ждём код второго фактора (до 10 минут) */
export type SessionData = { userId?: string; pending?: { userId: string; at: number } };

const COOKIE_NAME = "genagent_session";
const MAX_AGE = 60 * 60 * 24 * 14; // 14 дней

function password() {
  const p = process.env.SESSION_PASSWORD;
  if (!p || p.length < 32) throw new Error("SESSION_PASSWORD в .env должен быть не короче 32 символов");
  return p;
}

export async function getSession(): Promise<SessionData> {
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  if (!cookie) return {};
  try {
    return await unsealData<SessionData>(cookie, { password: password(), ttl: MAX_AGE });
  } catch {
    return {};
  }
}

export async function setSession(data: SessionData) {
  const sealed = await sealData(data, { password: password(), ttl: MAX_AGE });
  (await cookies()).set(COOKIE_NAME, sealed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE_NAME);
}
