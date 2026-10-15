/**
 * Проверка ответа агента на выдуманные факты — без ИИ и бесплатно. Самая опасная ошибка агента — назвать цену,
 * телефон, адрес сайта, почту или сумму, которых нет ни в базе знаний, ни в данных бота. Ищем в ответе такие
 * «проверяемые» вещи и сверяем с тем, что агент видел (системные указания с базой знаний, переписка,
 * результаты инструментов). Чего там нет — «непроверенное»: помечаем, а по настройке агента не отправляем.
 */

const CURRENCY = /(грн|₴|uah|€|eur|евро|євро|\$|usd|долл|дол\.|%|руб)/i;
// Разделители тысяч: обычный, неразрывный и узкий пробел, точка, запятая, апостроф
const GROUPED = /\d{1,3}(?:[   .,'’]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

const digitsOnly = (s: string) => s.replace(/\D/g, "");
/** «147 312,50» → «147312,50»; «1.500» → «1500». */
function normalizeNumber(raw: string) {
  const grouped = raw.match(/^\d{1,3}(?:[   .,'’]\d{3})+/);
  if (grouped) return digitsOnly(grouped[0]) + raw.slice(grouped[0].length).replace(/,/, ".");
  return raw.replace(",", ".");
}

function numbersIn(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(GROUPED)) {
    const n = normalizeNumber(m[0]);
    out.add(n);
    out.add(n.replace(/\.0+$/, ""));
    out.add(n.split(".")[0]);
  }
  return out;
}

/** Проверяемые факты ответа, которых нет в источниках (до 5 штук, как написаны в ответе). */
export function unverifiedFacts(reply: string, sources: string): string[] {
  const src = sources.toLowerCase();
  const srcDigits = digitsOnly(sources);
  const srcNumbers = numbersIn(sources);
  const found: string[] = [];
  let rest = reply;

  // Ссылки и почта
  for (const m of reply.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/[^\s)»"]+|\b(?:www\.)?[a-z0-9-]+\.(?:com|ua|net|org|es|io|me|app|shop|store|info|biz)(?:\/[^\s)»"]*)?/gi)) {
    const token = m[0].replace(/[.,;:!?]+$/, "");
    const key = token.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    if (!src.includes(key.split("/")[0])) found.push(token);
    rest = rest.replace(m[0], " ");
  }
  // Телефоны (от 9 цифр)
  for (const m of rest.matchAll(/\+?\d[\d  ()-]{7,}\d/g)) {
    const d = digitsOnly(m[0]);
    if (d.length < 9) continue;
    // Сравниваем по последним 9 цифрам: +380 / 0 в начале пишут по-разному
    if (!srcDigits.includes(d.slice(-9))) found.push(m[0].trim());
    rest = rest.replace(m[0], " ");
  }
  // Суммы и числа: от трёх цифр или рядом с валютой/процентом; годы не трогаем
  for (const m of rest.matchAll(GROUPED)) {
    const raw = m[0];
    const n = normalizeNumber(raw);
    const whole = n.split(".")[0];
    const around = rest.slice(Math.max(0, (m.index ?? 0) - 4), (m.index ?? 0) + raw.length + 6);
    const money = CURRENCY.test(around);
    if (!money && whole.length < 3) continue;
    if (!money && /^(19|20)\d\d$/.test(whole)) continue;
    if (srcNumbers.has(n) || srcNumbers.has(whole) || srcNumbers.has(n.replace(/\.0+$/, ""))) continue;
    found.push(raw.trim());
  }
  return [...new Set(found)].slice(0, 5);
}
