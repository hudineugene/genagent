/** Стикер клиента: отмечен журналом бота (kind) или пришёл подписью «Стикер» / «[стикер]» (старые записи без отметки). */
export function isSticker(text: string, kind?: string) {
  return kind === "sticker" || /^\[?(стикер|стікер|sticker)\]?$/i.test(text.trim());
}
