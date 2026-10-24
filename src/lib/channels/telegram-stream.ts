import "server-only";
import { sendMessageDraft } from "./telegram-api";

/**
 * Ответ в Telegram по мере написания: черновик (sendMessageDraft) обновляется не чаще раза в 0,8 с и только с
 * заметным приростом текста; служебные метки [[…]] клиент не видит. guard — проверка черновика (утечка инструкций):
 * не прошёл — черновики прекращаются, клиент получит только проверенный итог. Итог отправляется обычным сообщением.
 */
export function telegramStream(token: string, chatId: string, guard: (text: string) => boolean, opts: { minChars?: number; minMs?: number } = {}) {
  const draftId = 1 + Math.floor(Math.random() * 2_000_000_000);
  const minChars = opts.minChars ?? 30;
  const minMs = opts.minMs ?? 800;
  let lastAt = 0;
  let sentLen = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let sent = 0;
  const send = (text: string) => {
    sent++;
    chain = chain.then(() => sendMessageDraft(token, chatId, draftId, text)).catch(() => void (stopped = true));
  };
  return {
    /** «Думает…» сразу, пока модель начинает ответ */
    start() {
      send("");
    },
    push(full: string) {
      if (stopped) return;
      const text = visibleDraft(full);
      const now = Date.now();
      if (text.length - sentLen < minChars || now - lastAt < minMs) return;
      if (!guard(text)) return void (stopped = true);
      lastAt = now;
      sentLen = text.length;
      send(text);
    },
    async done() {
      await chain;
      return sent;
    },
  };
}

/** Текст черновика: без служебных меток (и недописанной метки в конце), без markdown, до 4096 знаков. */
export function visibleDraft(full: string) {
  const cut = full.lastIndexOf("[[");
  const tail = cut >= 0 && !full.slice(cut).includes("]]") ? full.slice(0, cut) : full;
  return tail
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim()
    .slice(0, 4096);
}
