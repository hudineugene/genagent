"use server";
import { getPhone } from "@/lib/channels/meta/whatsapp";

import { randomBytes } from "node:crypto";
import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, channels, clients, type ApiConfig, type EmailConfig, type InstagramConfig, type TelegramConfig, type ThreadsConfig, type WidgetConfig, WIDGET_LANGS, type WhatsAppConfig, type ViberConfig, type VoiceConfig, type MessengerConfig, type SmsChannelConfig } from "@/db/schema";
import { EmailError, GMAIL, pollNow, verifyEmail } from "@/lib/channels/email";
import { createAuthorizeUrl } from "@/lib/channels/meta/connect";
import { TelegramError, getMe } from "@/lib/channels/telegram-api";
import { startPoller, stopPoller } from "@/lib/channels/telegram-poller";

import { requireOwned } from "@/lib/access";
export type ChannelResult = { error?: string; ok?: boolean };

async function loadAgent(agentId: string) {
  const [row] = await db
    .select({ agent: agents, client: clients })
    .from(agents)
    .innerJoin(clients, eq(clients.id, agents.clientId))
    .where(eq(agents.id, agentId));
  return row;
}

export async function addTelegramChannel(
  agentId: string,
  _prev: ChannelResult | undefined,
  formData: FormData,
): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const token = String(formData.get("token") ?? "").trim();
  if (!/^\d+:[\w-]{20,}$/.test(token)) return { error: "token_format" };
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };

  // Один бот — один агент: иначе две копии будут спорить за сообщения.
  const existing = await db.select({ id: channels.id, config: channels.config }).from(channels).where(eq(channels.type, "telegram"));
  if (existing.some((c) => "token" in c.config && c.config.token === token)) return { error: "token_used" };

  let me;
  try {
    me = await getMe(token);
  } catch (e) {
    return { error: e instanceof TelegramError && e.code === 401 ? "token_invalid" : "telegram_unreachable" };
  }

  const [ch] = await db
    .insert(channels)
    .values({
      agentId,
      clientId: row.client.id,
      type: "telegram",
      name: `@${me.username}`,
      config: { token, username: me.username, botName: me.first_name },
    })
    .returning({ id: channels.id });
  startPoller(ch.id);
  refresh();
  return { ok: true };
}

/** Свой бот: ответы на комментарии, которые он присылает, — на одобрение или сразу. */
export async function updateApiChannel(channelId: string, patch: { approval?: boolean; botNote?: string; followUps?: boolean; orderNotes?: boolean; ratingInvite?: boolean }): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const data = z.object({ approval: z.boolean().optional(), botNote: z.string().trim().max(1000).optional(), followUps: z.boolean().optional(), orderNotes: z.boolean().optional(), ratingInvite: z.boolean().optional() }).parse(patch);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "api") return { error: "not_found" };
  await db.update(channels).set({ config: { ...(ch.config as ApiConfig), ...data } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

/** Telegram: ответы на комментарии под постами канала и одобрение этих ответов. */
export async function updateTelegramChannel(channelId: string, patch: { comments?: boolean; approval?: boolean }): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const data = z.object({ comments: z.boolean().optional(), approval: z.boolean().optional() }).parse(patch);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "telegram") return { error: "not_found" };
  const old = ch.config as TelegramConfig;
  // Первое включение комментариев — по умолчанию на одобрение: ответ публичный.
  const config: TelegramConfig = { ...old, ...data, approval: data.approval ?? old.approval ?? true };
  await db.update(channels).set({ config }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

export async function addWidgetChannel(agentId: string): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const config: WidgetConfig = {
    title: row.client.name,
    subtitle: "",
    color: row.client.color,
    position: "right",
  };
  await db.insert(channels).values({ agentId, clientId: row.client.id, type: "widget", name: "Widget", config });
  refresh();
  return { ok: true };
}

const widgetSchema = z.object({
  title: z.string().trim().min(1).max(80),
  subtitle: z.string().trim().max(120).default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.enum(["right", "left"]),
  telegramBot: z
    .string()
    .trim()
    .regex(/^@?[A-Za-z0-9_]{5,32}$|^$/)
    .default("")
    .transform((s) => s.replace(/^@/, "")),
  teaser: z.string().trim().max(140).default(""),
  teaserDelay: z.coerce.number().int().min(3).max(300).default(20),
  voice: z.preprocess((v) => v === "on" || v === "true", z.boolean()).default(false),
});

/** Кнопки-подсказки: по одной в строке, до 4, каждая до 40 символов. */
const quickList = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split("\n")
    .map((s) => s.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 4);

export async function updateWidget(
  channelId: string,
  _prev: ChannelResult | undefined,
  formData: FormData,
): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const parsed = widgetSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid" };
  // Тексты на языках посетителя: l_<язык>_title / _subtitle / _greeting / _quick
  const locales: NonNullable<WidgetConfig["locales"]> = {};
  for (const lang of WIDGET_LANGS) {
    const v = (k: string) => String(formData.get(`l_${lang}_${k}`) ?? "").trim();
    const loc = { title: v("title").slice(0, 80), subtitle: v("subtitle").slice(0, 120), greeting: v("greeting").slice(0, 1000), quick: quickList(formData.get(`l_${lang}_quick`)), teaser: v("teaser").slice(0, 140) };
    if (loc.title || loc.subtitle || loc.greeting || loc.quick.length || loc.teaser) locales[lang] = loc;
  }
  const config: WidgetConfig = { ...parsed.data, quick: quickList(formData.get("quick")), locales };
  await db.update(channels).set({ config }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

export async function setChannelEnabled(channelId: string, enabled: boolean): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const [ch] = await db
    .update(channels)
    .set({ enabled, error: null })
    .where(eq(channels.id, channelId))
    .returning({ type: channels.type });
  if (ch?.type === "telegram") {
    if (enabled) startPoller(channelId);
    else stopPoller(channelId);
  }
  refresh();
  return { ok: true };
}

export async function deleteChannel(channelId: string): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  stopPoller(channelId);
  // Viber: снять вебхук, чтобы бот перестал слать сообщения на удалённый канал
  const [ch] = await db.select({ type: channels.type, config: channels.config }).from(channels).where(eq(channels.id, channelId));
  if (ch?.type === "viber") {
    const { setWebhook } = await import("@/lib/channels/viber");
    await setWebhook((ch.config as ViberConfig).token, "").catch(() => {});
  }
  await db.delete(channels).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

/** Ссылка входа в Instagram/Threads для подключения аккаунта к агенту (действует сутки). */
export async function startSocialConnect(
  agentId: string,
  provider: "instagram" | "threads",
): Promise<{ url?: string; error?: string }> {
  const user = await requireOwned("agent", agentId);
  try {
    return { url: await createAuthorizeUrl(provider, agentId, user.id) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const socialSchema = z.object({
  dm: z.boolean().optional(),
  comments: z.boolean().optional(),
  approval: z.boolean().optional(),
});

/** Настройки аккаунта соцсети: директ, комментарии, одобрение публичных ответов. */
export async function updateSocialChannel(
  channelId: string,
  patch: z.input<typeof socialSchema>,
): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const data = socialSchema.parse(patch);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || (ch.type !== "instagram" && ch.type !== "threads")) return { error: "not_found" };
  const config = { ...(ch.config as InstagramConfig | ThreadsConfig), ...data };
  // Включили комментарии заново — не отвечаем на всё, что накопилось, пока они были выключены.
  if (data.comments === true && "comments" in ch.config && !ch.config.comments) {
    (config as InstagramConfig).since = Math.floor(Date.now() / 1000);
  }
  await db.update(channels).set({ config }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

const triggerSchema = z
  .array(z.object({ keyword: z.string().trim().min(1).max(40), dm: z.string().trim().min(1).max(1000), reply: z.string().trim().max(300).default(""), postId: z.string().trim().max(40).optional() }))
  .max(20);

/** Кодовые слова в комментариях Instagram → личное сообщение автору. */
export async function saveInstagramTriggers(channelId: string, triggers: z.input<typeof triggerSchema>): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const parsed = triggerSchema.safeParse(triggers.filter((t) => t.keyword.trim() || t.dm.trim()));
  if (!parsed.success) return { error: "invalid" };
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "instagram") return { error: "not_found" };
  await db.update(channels).set({ config: { ...(ch.config as InstagramConfig), triggers: parsed.data.map((t) => ({ ...t, postId: t.postId || undefined })) } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

// ---------- почта ----------

const emailSchema = z.object({
  address: z.string().trim().toLowerCase().email(),
  // Gmail показывает пароль приложения группами через пробел — пробелы убираем.
  password: z.string().transform((s) => s.replace(/\s+/g, "")).pipe(z.string().min(8).max(100)),
  fromName: z.string().trim().max(80).optional(),
});

/** Подключить ящик Gmail (IMAP/SMTP, пароль приложения). Ответы по умолчанию — на одобрение. */
export async function addEmailChannel(
  agentId: string,
  _prev: ChannelResult | undefined,
  formData: FormData,
): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const parsed = emailSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.path[0] === "address" ? "email_address" : "email_password" };
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };

  const existing = await db.select({ config: channels.config }).from(channels).where(eq(channels.type, "email"));
  if (existing.some((c) => "address" in c.config && c.config.address === parsed.data.address)) return { error: "email_used" };

  const config: EmailConfig = {
    address: parsed.data.address,
    password: parsed.data.password,
    ...GMAIL,
    fromName: parsed.data.fromName || row.client.name,
    approval: true,
  };
  try {
    await verifyEmail(config);
  } catch (e) {
    return { error: e instanceof EmailError && e.code === "auth_failed" ? "email_auth_failed" : "email_unreachable" };
  }
  const [ch] = await db
    .insert(channels)
    .values({ agentId, clientId: row.client.id, type: "email", name: parsed.data.address, config })
    .returning({ id: channels.id });
  pollNow(ch.id); // запомнить текущее состояние ящика: отвечаем только на новые письма
  refresh();
  return { ok: true };
}

export async function updateEmailChannel(channelId: string, patch: { approval?: boolean; fromName?: string }): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const data = z.object({ approval: z.boolean().optional(), fromName: z.string().trim().min(1).max(80).optional() }).parse(patch);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "email") return { error: "not_found" };
  await db.update(channels).set({ config: { ...(ch.config as EmailConfig), ...data } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

// ---------- свой бот (API) ----------

const newApiKey = () => `ga_${randomBytes(24).toString("base64url")}`;

/** Подключить свой бот клиента: бот обращается к агенту по адресу канала с ключом. */
export async function addApiChannel(agentId: string, label: string): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const name = label.trim().slice(0, 80) || "API";
  const config: ApiConfig = { key: newApiKey(), label: name };
  await db.insert(channels).values({ agentId, clientId: row.client.id, type: "api", name, config });
  refresh();
  return { ok: true };
}

/** Facebook Messenger: токен страницы — проверяем у Meta, подписываем страницу на вебхуки, создаём канал. */
export async function addMessengerChannel(agentId: string, token: string): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const tok = token.trim();
  if (tok.length < 20) return { error: "invalid" };
  const m = await import("@/lib/channels/meta/messenger");
  let page: { id: string; name: string };
  try {
    page = await m.getPage(tok);
    await m.subscribePage(tok, page.id);
  } catch (e) {
    return { error: e instanceof Error ? `messenger: ${e.message.slice(0, 150)}` : "messenger_error" };
  }
  const existing = await db.select({ config: channels.config }).from(channels).where(eq(channels.type, "messenger"));
  if (existing.some((c) => (c.config as MessengerConfig).pageId === page.id)) return { error: "token_used" };
  const config: MessengerConfig = { pageId: page.id, pageName: page.name, token: tok };
  await db.insert(channels).values({ agentId, clientId: row.client.id, type: "messenger", name: page.name, config });
  refresh();
  return { ok: true };
}

/** SMS через Twilio: аккаунт проверяется; адрес для входящих — в карточке канала. */
export async function addSmsChannel(agentId: string, input: { accountSid: string; authToken: string; from: string }): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const d = z.object({ accountSid: z.string().trim().regex(/^AC[0-9a-f]{32}$/i), authToken: z.string().trim().min(20).max(100), from: z.string().trim().regex(/^\+\d{8,15}$/) }).safeParse(input);
  if (!d.success) return { error: "sms_invalid" };
  const { checkTwilio } = await import("@/lib/channels/sms");
  try {
    await checkTwilio(d.data);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "twilio_error" };
  }
  const config: SmsChannelConfig = d.data;
  await db.insert(channels).values({ agentId, clientId: row.client.id, type: "sms", name: d.data.from, config });
  refresh();
  return { ok: true };
}

/** Звонки: агент как «своя модель» для Vapi / ElevenLabs — канал с ключом и адресом /chat/completions. */
export async function addVoiceChannel(agentId: string, provider: "vapi" | "elevenlabs" | "other"): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const p = (["vapi", "elevenlabs", "other"] as const).includes(provider) ? provider : "other";
  const config: VoiceConfig = { key: newApiKey(), provider: p };
  await db.insert(channels).values({ agentId, clientId: row.client.id, type: "voice", name: p === "vapi" ? "Vapi" : p === "elevenlabs" ? "ElevenLabs" : "Voice", config });
  refresh();
  return { ok: true };
}

export async function updateVoiceChannel(channelId: string, phone: string): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "voice") return { error: "not_found" };
  await db.update(channels).set({ config: { ...(ch.config as VoiceConfig), phone: phone.trim().slice(0, 40) } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

/** WhatsApp Business: ID номера и постоянный токен — проверяем у Meta и создаём канал. */
export async function addWhatsAppChannel(agentId: string, phoneNumberId: string, token: string): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const id = phoneNumberId.trim();
  const tok = token.trim();
  if (!/^\d{6,25}$/.test(id) || tok.length < 20) return { error: "invalid" };
  let phone: Awaited<ReturnType<typeof getPhone>>;
  try {
    phone = await getPhone(tok, id);
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : "whatsapp_error" };
  }
  const config: WhatsAppConfig = { phoneNumberId: id, displayPhone: phone.display_phone_number, verifiedName: phone.verified_name, token: tok };
  await db.insert(channels).values({ agentId, clientId: row.client.id, type: "whatsapp", name: phone.display_phone_number, config });
  refresh();
  return { ok: true };
}

/** Viber: бот по токену из партнёрского кабинета; вебхук регистрируется сразу (Viber проверяет адрес). */
export async function addViberChannel(agentId: string, token: string, welcome: string): Promise<ChannelResult> {
  await requireOwned("agent", agentId);
  const row = await loadAgent(agentId);
  if (!row) return { error: "not_found" };
  const tok = token.trim();
  if (!/^[\w-]{20,80}$/.test(tok)) return { error: "viber_token_format" };
  const { publicUrl } = await import("@/lib/settings");
  const base = publicUrl();
  if (!base) return { error: "no_public_url" };
  const existing = await db.select({ config: channels.config }).from(channels).where(eq(channels.type, "viber"));
  if (existing.some((c) => (c.config as ViberConfig).token === tok)) return { error: "viber_token_used" };
  const v = await import("@/lib/channels/viber");
  let info: Awaited<ReturnType<typeof v.getAccountInfo>>;
  try {
    info = await v.getAccountInfo(tok);
  } catch (e) {
    return { error: e instanceof v.ViberError && e.status === 2 ? "viber_token_invalid" : "viber_unreachable" };
  }
  const config: ViberConfig = { token: tok, botName: info.name, avatar: info.icon, uri: info.uri, welcome: welcome.trim().slice(0, 500) };
  const [ch] = await db.insert(channels).values({ agentId, clientId: row.client.id, type: "viber", name: info.name, config }).returning({ id: channels.id });
  try {
    await v.setWebhook(tok, `${base}/api/webhooks/viber/${ch.id}`);
  } catch (e) {
    await db.delete(channels).where(eq(channels.id, ch.id));
    return { error: e instanceof Error ? `viber: ${e.message.slice(0, 150)}` : "viber_unreachable" };
  }
  refresh();
  return { ok: true };
}

export async function updateViberChannel(channelId: string, welcome: string): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "viber") return { error: "not_found" };
  await db.update(channels).set({ config: { ...(ch.config as ViberConfig), welcome: welcome.trim().slice(0, 500) } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

/** Новый ключ: старый перестаёт работать сразу — его нужно заменить в настройках бота. */
export async function regenerateApiKey(channelId: string): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || (ch.type !== "api" && ch.type !== "voice")) return { error: "not_found" };
  await db.update(channels).set({ config: { ...(ch.config as ApiConfig), key: newApiKey() } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

/** WhatsApp: ID бизнес-аккаунта, шаблон для сообщений вне окна, цены сообщений для учёта расходов. */
export async function saveWhatsAppSettings(
  channelId: string,
  input: { wabaId: string; proactiveTemplate: { name: string; language: string } | null; price: { service: number; template: number } },
): Promise<ChannelResult> {
  await requireOwned("channel", channelId);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "whatsapp") return { error: "not_found" };
  const waba = input.wabaId.trim();
  if (waba && !/^\d{6,25}$/.test(waba)) return { error: "invalid" };
  const price = { service: Math.min(1, Math.max(0, Number(input.price.service) || 0)), template: Math.min(1, Math.max(0, Number(input.price.template) || 0)) };
  const cfg = ch.config as WhatsAppConfig;
  const tpl = input.proactiveTemplate && cfg.templates?.some((t) => t.name === input.proactiveTemplate!.name && t.language === input.proactiveTemplate!.language) ? input.proactiveTemplate : undefined;
  await db.update(channels).set({ config: { ...cfg, wabaId: waba || undefined, proactiveTemplate: tpl, price } }).where(eq(channels.id, channelId));
  refresh();
  return { ok: true };
}

/** Загрузить утверждённые шаблоны из Meta. */
export async function syncWhatsAppTemplates(channelId: string): Promise<ChannelResult & { count?: number }> {
  await requireOwned("channel", channelId);
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch || ch.type !== "whatsapp") return { error: "not_found" };
  const cfg = ch.config as WhatsAppConfig;
  if (!cfg.wabaId) return { error: "no_waba" };
  try {
    const { listTemplates } = await import("@/lib/channels/meta/whatsapp");
    const templates = await listTemplates(cfg.token, cfg.wabaId);
    await db.update(channels).set({ config: { ...cfg, templates } }).where(eq(channels.id, channelId));
    refresh();
    return { ok: true, count: templates.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : "whatsapp_error" };
  }
}
