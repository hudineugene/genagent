import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Двухфакторный вход по TOTP (RFC 6238): 6 цифр из Google Authenticator, 1Password и т. п., шаг 30 с, допуск ±1 шаг.
 * Секрет хранится зашифрованным (AES-256-GCM, ключ из SESSION_PASSWORD); коды восстановления — только хэши.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

/** Код на момент времени (для проверки и тестов). */
export function totpCode(secret: string, at = Date.now(), step = 30) {
  const counter = Math.floor(at / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Шаг (номер 30-секундного окна), в котором код верен, или null. Допуск — соседние окна. */
export function totpStep(secret: string, code: string, at = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  for (const d of [-1, 0, 1]) {
    const t = at + d * 30_000;
    if (timingSafeEqual(Buffer.from(totpCode(secret, t)), Buffer.from(c))) return Math.floor(t / 30_000);
  }
  return null;
}

export function verifyTotp(secret: string, code: string, at = Date.now()) {
  return totpStep(secret, code, at) !== null;
}

export function otpauthUri(secret: string, email: string, issuer = "GenAgent") {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const key = () => createHash("sha256").update(`totp:${process.env.SESSION_PASSWORD ?? ""}`).digest();

export function sealSecret(secret: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64")}`;
}

export function openSecret(sealed: string) {
  const raw = Buffer.from(sealed.replace(/^v1:/, ""), "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

const hashCode = (c: string) => createHash("sha256").update(c.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

/** 8 кодов восстановления вида ABCD-EFGH: показываем один раз, храним хэши. */
export function newRecoveryCodes() {
  const codes = Array.from({ length: 8 }, () => {
    const s = base32Encode(randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

/** Код восстановления подошёл — возвращает оставшиеся хэши (использованный убран), иначе null. */
export function consumeRecoveryCode(hashes: string[], code: string) {
  const h = hashCode(code);
  return hashes.includes(h) ? hashes.filter((x) => x !== h) : null;
}
