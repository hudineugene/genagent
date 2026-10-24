/**
 * Повторы входящих уведомлений (Meta, Twilio, Viber шлют одно событие дважды, иногда одновременно).
 * Проверка «есть ли уже в базе» между чтением и записью ждёт базу, и два одинаковых запроса проходят оба.
 * Программа работает одним процессом, поэтому событие «занимается» здесь сразу и без ожиданий; проверка по базе
 * остаётся для повторов после перезапуска. Ключи хранятся 15 минут.
 */
const TTL_MS = 15 * 60_000;
const g = globalThis as unknown as { __inboundSeen?: Map<string, number> };
const seen = (g.__inboundSeen ??= new Map());

/** true — событие пришло впервые (обрабатываем), false — повтор. */
export function firstSeen(key: string, now = Date.now()) {
  if (seen.size > 20_000) for (const [k, at] of seen) if (now - at > TTL_MS) seen.delete(k);
  const at = seen.get(key);
  if (at !== undefined && now - at < TTL_MS) return false;
  seen.set(key, now);
  return true;
}

/** Обработка не удалась — повтор от провайдера снова примем. */
export function forget(key: string) {
  seen.delete(key);
}
