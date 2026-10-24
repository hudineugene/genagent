import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, channels, clientLogistics, clientPayments, clients } from "@/db/schema";

/**
 * Список обработчиков (субпроцессоров) данных клиента — по тому, что у него реально подключено, и шаблон договора
 * обработки данных (DPA) для подписания с бизнесом-клиентом. Шаблон — не юридическая консультация: перед
 * подписанием его проверяет юрист.
 */
export type Subprocessor = { name: string; purpose: string; data: string; location: string };

export async function subprocessors(clientId: string): Promise<Subprocessor[]> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return [];
  const chans = await db.select({ type: channels.type }).from(channels).where(eq(channels.clientId, clientId));
  const types = new Set(chans.map((c) => c.type));
  const configs = (await db.select({ config: agents.config }).from(agents).where(eq(agents.clientId, clientId))).map((a) => a.config as { model?: string; voiceReplies?: boolean; calendar?: { enabled?: boolean } });
  const [logi] = await db.select().from(clientLogistics).where(eq(clientLogistics.clientId, clientId));
  const usesOpenAi = Boolean(client.apiKeys.openai || process.env.OPENAI_API_KEY);
  const list: Subprocessor[] = [
    { name: "Anthropic PBC", purpose: "Ответы ИИ-агента, разбор переписки, тексты", data: "Текст сообщений, данные из базы знаний", location: "США (стандартные договорные условия ЕС)" },
  ];
  if (usesOpenAi) list.push({ name: "OpenAI, L.L.C.", purpose: "Расшифровка и озвучка голосовых, картинки", data: "Голосовые сообщения, тексты для озвучки", location: "США (стандартные договорные условия ЕС)" });
  if (configs.some((c) => c.model?.startsWith("openrouter:")) || client.apiKeys.openrouter) list.push({ name: "OpenRouter, Inc.", purpose: "Доступ к другим моделям ИИ", data: "Текст сообщений", location: "США" });
  if (types.has("telegram") || types.has("api")) list.push({ name: "Telegram Messenger Inc.", purpose: "Канал общения, уведомления сотрудникам", data: "Сообщения, имя и ник пользователя", location: "ОАЭ / Нидерланды" });
  if (types.has("viber")) list.push({ name: "Viber Media S.à r.l.", purpose: "Канал Viber", data: "Сообщения, имя профиля, идентификатор пользователя", location: "Люксембург (ЕС)" });
  if (types.has("whatsapp") || types.has("instagram") || types.has("threads")) list.push({ name: "Meta Platforms Ireland Ltd.", purpose: "Каналы WhatsApp, Instagram, Threads", data: "Сообщения, номер телефона, имя профиля", location: "Ирландия (ЕС)" });
  if (configs.some((c) => c.calendar?.enabled) || logi?.baseAddress || client.apiKeys.googleMaps) list.push({ name: "Google LLC", purpose: "Календарь записи, Google Таблицы, маршруты", data: "Имя, контакт, время записи, адреса доставки", location: "США / ЕС" });
  const [pay] = await db.select({ provider: clientPayments.provider, enabled: clientPayments.enabled }).from(clientPayments).where(eq(clientPayments.clientId, clientId));
  if (pay?.enabled) {
    const bank = { liqpay: "АО КБ «ПриватБанк» (LiqPay)", wayforpay: "ООО «Вей Фор Пей» (WayForPay)", monobank: "АО «Универсал Банк» (monobank)" }[pay.provider];
    list.push({ name: bank, purpose: "Приём оплат по ссылке", data: "Сумма, назначение и номер заказа; данные карты обрабатывает только банк", location: "Украина" });
  }
  if (types.has("email")) list.push({ name: "Почтовый сервис бизнеса (IMAP/SMTP)", purpose: "Канал «почта»", data: "Письма и адреса", location: "по договору бизнеса с почтовым сервисом" });
  list.push({ name: "[Хостинг-провайдер сервера студии]", purpose: "Хранение базы и файлов, работа программы", data: "Все данные выше", location: "[страна]" });
  return list;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Шаблон DPA (HTML для печати и сохранения в PDF) с заполненным списком обработчиков и сроком хранения. */
export async function dpaHtml(clientId: string, studio = "[Название студии]") {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) return null;
  const subs = await subprocessors(clientId);
  const retention = client.retentionDays ? `${client.retentionDays} дней с последнего сообщения, затем удаляются автоматически` : "[срок хранения не задан — укажите в настройках клиента]";
  const date = new Date().toLocaleDateString("ru-RU");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Договор обработки данных — ${esc(client.name)}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 20px;color:#111}h1{font-size:22px}h2{font-size:16px;margin-top:24px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}.note{background:#fff7e0;padding:10px 12px;border-radius:8px;font-size:13px}@media print{.note{display:none}}</style></head><body>
<p class="note">Шаблон. Это не юридическая консультация: перед подписанием проверьте текст с юристом и заполните поля в квадратных скобках.</p>
<h1>Договор обработки персональных данных (DPA)</h1>
<p>Дата: ${date}</p>
<p><b>Контролёр:</b> ${esc(client.name)} [реквизиты]. <b>Обработчик:</b> ${esc(studio)} [реквизиты].</p>
<h2>1. Предмет</h2>
<p>Обработчик по поручению Контролёра обеспечивает работу ИИ-агентов, которые общаются с клиентами Контролёра в мессенджерах, на сайте и по почте, и обрабатывает для этого персональные данные только по документированным указаниям Контролёра (ст. 28 GDPR).</p>
<h2>2. Данные и субъекты</h2>
<p>Субъекты: клиенты и потенциальные клиенты Контролёра, его сотрудники (если подключён агент для команды). Категории данных: имя, ник и идентификатор в мессенджере, телефон, адрес электронной почты, содержание переписки, голосовые сообщения и фото, которые прислал человек, данные анкет, записей и заказов. Особые категории данных не обрабатываются, если Контролёр прямо не поручил иное.</p>
<h2>3. Цели и срок</h2>
<p>Цели: ответы на обращения, запись, расчёты и заказы, передача обращений сотрудникам Контролёра, отчёты Контролёру. Срок хранения переписки: ${esc(retention)}. По окончании договора данные удаляются или возвращаются Контролёру в течение 30 дней.</p>
<h2>4. Раскрытие ИИ</h2>
<p>Агент сообщает человеку, что тот общается с ИИ от имени Контролёра, в первом ответе разговора (EU AI Act, ст. 50).</p>
<h2>5. Меры безопасности</h2>
<p>Доступ к студии — только сотрудникам Обработчика через закрытую сеть; пароли хранятся в виде хэшей; ключи доступа к сервисам ИИ не передаются в браузер; ежедневные резервные копии, копия вне сервера зашифрована паролем; журнал расходов и действий агента.</p>
<h2>6. Обработчики (субпроцессоры)</h2>
<table><tr><th>Организация</th><th>Для чего</th><th>Какие данные</th><th>Где</th></tr>
${subs.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.purpose)}</td><td>${esc(s.data)}</td><td>${esc(s.location)}</td></tr>`).join("\n")}
</table>
<p>Обработчик уведомляет Контролёра о новом субпроцессоре не позднее чем за 14 дней.</p>
<h2>7. Права субъектов</h2>
<p>По запросу Контролёра Обработчик в течение 5 рабочих дней выгружает все данные человека одним файлом (ст. 15, 20 GDPR) или полностью их удаляет (ст. 17), включая файлы.</p>
<h2>8. Инциденты</h2>
<p>Об утечке персональных данных Обработчик сообщает Контролёру без неоправданной задержки, не позднее 48 часов с момента обнаружения.</p>
<p style="margin-top:40px">Контролёр: ____________________ &nbsp;&nbsp;&nbsp; Обработчик: ____________________</p>
</body></html>`;
}
