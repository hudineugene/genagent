"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { KEY_KINDS, forgetClientKeys, type KeyKind } from "@/lib/keys";

import { requireClient } from "@/lib/access";
/** Проверить ключ бесплатным запросом (список моделей); Google Maps — по формату (бесплатной проверки нет). */
async function verify(kind: KeyKind, key: string): Promise<string | null> {
  try {
    if (kind === "anthropic") {
      await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
      return null;
    }
    if (kind === "openai") {
      await new OpenAI({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL || undefined }).models.list();
      return null;
    }
    if (kind === "openrouter") {
      const res = await fetch(`${process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? null : "rejected";
    }
    return /^AIza[0-9A-Za-z_-]{30,}$/.test(key) ? null : "format";
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status === 401 || status === 403 ? "rejected" : "unreachable";
  }
}

/** Сохранить ключ клиента (после проверки) или убрать (пустое значение). */
export async function saveClientKey(clientId: string, kind: KeyKind, value: string): Promise<{ error?: string }> {
  await requireClient(clientId);
  if (!KEY_KINDS.includes(kind)) return { error: "invalid" };
  const key = value.trim();
  if (key.length > 500) return { error: "invalid" };
  if (key) {
    const err = await verify(kind, key);
    if (err) return { error: err };
  }
  const [row] = await db.select({ keys: clients.apiKeys }).from(clients).where(eq(clients.id, clientId));
  if (!row) return { error: "not_found" };
  const next = { ...row.keys };
  if (key) next[kind] = key;
  else delete next[kind];
  await db.update(clients).set({ apiKeys: next }).where(eq(clients.id, clientId));
  forgetClientKeys(clientId);
  refresh();
  return {};
}
