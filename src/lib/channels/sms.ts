import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * SMS через Twilio: номер Twilio (или подключённый к Twilio), входящие — на наш вебхук (подпись X-Twilio-Signature),
 * ответы и напоминания — Messages API. Длинный ответ режется на SMS автоматически самим Twilio.
 */
const API = () => (process.env.TWILIO_API_URL ?? "https://api.twilio.com").replace(/\/$/, "");

import type { SmsChannelConfig } from "@/db/schema";

export type SmsConfig = SmsChannelConfig;

export async function sendSms(cfg: SmsConfig, to: string, text: string): Promise<string | null> {
  const res = await fetch(`${API()}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: cfg.from, Body: text.slice(0, 1500) }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) throw new Error(`twilio: ${j.message ?? res.status}`);
  return j.sid ?? null;
}

/** Проверить аккаунт Twilio (при подключении). */
export async function checkTwilio(cfg: Pick<SmsConfig, "accountSid" | "authToken">) {
  const res = await fetch(`${API()}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}.json`, {
    headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(res.status === 401 ? "twilio_auth" : `twilio_http_${res.status}`);
}

/** Подпись Twilio: HMAC-SHA1(токен, адрес + параметры по алфавиту ключ+значение), base64. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validTwilio(authToken: string, url: string, params: Record<string, string>, header: string | null) {
  if (!header) return false;
  const want = twilioSignature(authToken, url, params);
  return want.length === header.length && timingSafeEqual(Buffer.from(want), Buffer.from(header));
}
