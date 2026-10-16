"use server";

import { z } from "zod";
import { createPrivateKey } from "node:crypto";
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels, settings } from "@/db/schema";
import { getMe } from "@/lib/channels/telegram-api";
import { getNotifySettings, newLinkCode, notifyTest, saveNotifySettings } from "@/lib/notify/telegram";
import { MIN_BACKUP_PASSWORD, deriveKey, getOffsiteSettings, saveOffsiteSettings, sendOffsiteBackup } from "@/lib/offsite-backup";
import { requireAdmin, requireUser } from "@/lib/auth";
import { checkCalendarAccess } from "@/lib/agent/tools";
import { getMetaSettings, setSetting, type MetaSettings } from "@/lib/settings";

export type IntegrationsResult = { ok?: boolean; error?: string };

/** Сохранить ключи приложений Meta. Пустое поле секрета — оставить прежний. */
export async function saveMetaSettings(
  _prev: IntegrationsResult | undefined,
  formData: FormData,
): Promise<IntegrationsResult> {
  await requireAdmin();
  const current = await getMetaSettings();
  const next: MetaSettings = { ...current };

  for (const p of ["instagram", "threads"] as const) {
    const appId = String(formData.get(`${p}AppId`) ?? "").trim();
    const secret = String(formData.get(`${p}AppSecret`) ?? "").trim();
    if (appId && !/^\d{5,25}$/.test(appId)) return { error: "app_id" };
    if (secret && !/^[0-9a-f]{20,64}$/i.test(secret)) return { error: "app_secret" };
    if (!appId) {
      delete next[p];
      continue;
    }
    const appSecret = secret || current[p]?.appSecret;
    if (!appSecret) return { error: "app_secret" };
    next[p] = { appId, appSecret };
  }

  await setSetting("meta", next);
  refresh();
  return { ok: true };
}

/** Сохранить JSON-ключ сервисного аккаунта Google (для записи в календари клиентов). */
export async function saveGoogleKey(
  _prev: IntegrationsResult | undefined,
  formData: FormData,
): Promise<IntegrationsResult> {
  await requireAdmin();
  let key: { type?: string; client_email?: string; private_key?: string; project_id?: string };
  try {
    key = JSON.parse(String(formData.get("key") ?? ""));
  } catch {
    return { error: "google_key" };
  }
  if (
    key.type !== "service_account" ||
    typeof key.client_email !== "string" ||
    !key.client_email.includes("@") ||
    typeof key.private_key !== "string" ||
    !key.private_key.includes("PRIVATE KEY")
  ) {
    return { error: "google_key" };
  }
  try {
    createPrivateKey(key.private_key);
  } catch {
    return { error: "google_key" };
  }
  await setSetting("google", { clientEmail: key.client_email, privateKey: key.private_key, projectId: key.project_id });
  refresh();
  return { ok: true };
}

export async function removeGoogleKey() {
  await requireAdmin();
  await db.delete(settings).where(eq(settings.key, "google"));
  refresh();
}

/** Проверка из конструктора агента: видит ли сервисный аккаунт календарь клиента. */
export async function checkCalendar(calendarId: string) {
  await requireUser();
  const id = calendarId.trim();
  if (!id) return { ok: false as const, code: "calendar_not_set" };
  return checkCalendarAccess(id);
}

// ---------- уведомления в Telegram ----------

/** Подключить бота уведомлений студии (токен из @BotFather). Адрес админки — тот, с которого её открыли. */
export async function saveNotifyBot(_prev: IntegrationsResult | undefined, formData: FormData): Promise<IntegrationsResult> {
  await requireAdmin();
  const token = String(formData.get("token") ?? "").trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return { error: "notify_token" };
  const used = await db.select({ config: channels.config }).from(channels).where(eq(channels.type, "telegram"));
  if (used.some((c) => "token" in c.config && c.config.token === token)) return { error: "notify_token_used" };
  let me;
  try {
    me = await getMe(token);
  } catch {
    return { error: "notify_token" };
  }
  const h = await headers();
  const origin = h.get("origin") ?? (h.get("referer") ? new URL(h.get("referer")!).origin : "");
  const current = await getNotifySettings();
  await saveNotifySettings({
    token,
    botUsername: me.username,
    linkCode: current?.token === token ? current.linkCode : newLinkCode(),
    adminUrl: origin,
    subscribers: current?.token === token ? current.subscribers : [],
  });
  refresh();
  return { ok: true };
}

export async function removeNotifyBot() {
  await requireAdmin();
  await saveNotifySettings(null);
  refresh();
}

/** Новая ссылка подписки — старая перестаёт работать (подписанные остаются). */
export async function regenerateNotifyLink() {
  await requireAdmin();
  const s = await getNotifySettings();
  if (s) await saveNotifySettings({ ...s, linkCode: newLinkCode() });
  refresh();
}

export async function removeNotifySubscriber(chatId: string) {
  await requireAdmin();
  const s = await getNotifySettings();
  if (s) await saveNotifySettings({ ...s, subscribers: s.subscribers.filter((x) => x.chatId !== chatId) });
  refresh();
}

export async function sendNotifyTest() {
  await requireAdmin();
  await notifyTest();
}

// ---------- копия базы в Telegram ----------

/** Включить/настроить отправку зашифрованной копии базы сотруднику (подписчику бота уведомлений). */
export async function saveOffsiteBackup(_prev: IntegrationsResult | undefined, formData: FormData): Promise<IntegrationsResult> {
  await requireAdmin();
  const notify = await getNotifySettings();
  if (!notify?.token) return { error: "backup_no_bot" };
  const chatId = String(formData.get("chatId") ?? "");
  const enabled = formData.get("enabled") === "on";
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!notify.subscribers.some((s) => s.chatId === chatId)) return { error: "backup_recipient" };
  const current = await getOffsiteSettings();
  let keys = current?.key ? { salt: current.salt, key: current.key } : null;
  if (password) {
    if (password.length < MIN_BACKUP_PASSWORD) return { error: "backup_password_short" };
    if (password !== confirm) return { error: "backup_password_mismatch" };
    keys = deriveKey(password);
  }
  if (enabled && !keys) return { error: "backup_password_short" };
  await saveOffsiteSettings({
    enabled,
    chatId,
    salt: keys?.salt ?? "",
    key: keys?.key ?? "",
    lastSentAt: current?.lastSentAt,
    lastError: current?.lastError,
  });
  refresh();
  return { ok: true };
}

/** «Отправить сейчас»: последняя ежедневная копия (или свежая, если копий ещё нет). */
export async function sendOffsiteBackupNow(): Promise<IntegrationsResult> {
  await requireAdmin();
  const { latestBackup } = await import("@/lib/backup");
  let file = latestBackup();
  if (!file) {
    const dir = process.env.BACKUP_DIR;
    if (!dir) return { error: "backup_no_dir" };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    // То же имя, что у ежедневных копий: она и станет первой из них.
    file = `${dir}/genagent-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.db`;
    db.$sqlite.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }
  const r = await sendOffsiteBackup(file);
  refresh();
  return r.ok ? { ok: true } : { error: r.error ?? "backup_failed" };
}

// ---------- еженедельная проверка агентов ----------

export async function saveWeeklyTestsAction(patch: { enabled: boolean; weekday: number; hour: number }): Promise<IntegrationsResult> {
  await requireAdmin();
  const data = z
    .object({ enabled: z.boolean(), weekday: z.number().int().min(1).max(7), hour: z.number().int().min(0).max(23) })
    .parse(patch);
  const { saveWeeklyTests } = await import("@/lib/tests/weekly");
  await saveWeeklyTests(data);
  return { ok: true };
}

// ---------- ежедневная сводка ----------

export async function saveDailyDigestAction(patch: { enabled: boolean; hour: number }): Promise<IntegrationsResult> {
  await requireAdmin();
  const data = z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23) }).parse(patch);
  const { saveDailyDigest } = await import("@/lib/agent/daily");
  await saveDailyDigest(data);
  return { ok: true };
}

// ---------- утренняя сводка лидов ----------

export async function saveLeadsAction(patch: { enabled: boolean; hour: number }): Promise<IntegrationsResult> {
  await requireAdmin();
  const data = z.object({ enabled: z.boolean(), hour: z.number().int().min(0).max(23) }).parse(patch);
  const { saveLeadsSettings } = await import("@/lib/agent/leads");
  await saveLeadsSettings(data);
  return { ok: true };
}

export async function sendLeadsNow(): Promise<IntegrationsResult> {
  await requireAdmin();
  const { sendLeadsDigest } = await import("@/lib/agent/leads");
  return (await sendLeadsDigest()) ? { ok: true } : { error: "empty" };
}

/** Напоминания, если клиент ждёт человека (lib/agent/waiting). */
export async function saveWaitingAction(patch: { enabled: boolean; firstMin: number; secondMin: number; fromHour: number; toHour: number }): Promise<IntegrationsResult> {
  await requireAdmin();
  const data = z
    .object({
      enabled: z.boolean(),
      firstMin: z.number().int().min(5).max(600),
      secondMin: z.number().int().min(10).max(1440),
      fromHour: z.number().int().min(0).max(23),
      toHour: z.number().int().min(0).max(24),
    })
    .parse(patch);
  const { saveWaitingSettings } = await import("@/lib/agent/waiting");
  await saveWaitingSettings({ ...data, secondMin: Math.max(data.secondMin, data.firstMin + 5) });
  return { ok: true };
}

/** «Прислать сейчас»: сводка за последние сутки. error: empty — за сутки ничего не было. */
export async function sendDailyDigestNow(): Promise<IntegrationsResult> {
  await requireAdmin();
  const { sendDailyDigest } = await import("@/lib/agent/daily");
  return (await sendDailyDigest()) ? { ok: true } : { error: "empty" };
}

/** «Запустить сейчас»: прогон идёт в фоне (несколько минут), отчёт придёт в Telegram. */
export async function runWeeklyTestsNow(): Promise<IntegrationsResult> {
  await requireAdmin();
  const { runWeeklyTests } = await import("@/lib/tests/weekly");
  void runWeeklyTests().catch((e) => console.error("weekly tests (manual) failed", e));
  return { ok: true };
}
