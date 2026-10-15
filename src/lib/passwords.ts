import "server-only";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

/** Случайный пароль из 12 символов без похожих букв (0/O, 1/l/I). */
export function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(12), (b) => alphabet[b % alphabet.length]).join("");
}
