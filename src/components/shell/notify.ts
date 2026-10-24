/**
 * Уведомления браузера и звук о важных событиях (передача менеджеру, горячий клиент). Включает сотрудник в меню
 * профиля — выбор хранится в этом браузере; браузер сам спрашивает разрешение.
 */
const KEY = "browser-notify";
export const NOTIFY_EVENT = "genagent:notify";

export function notifyOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "on" && typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch {
    return false;
  }
}

export function notifyRaw(): string {
  try {
    return localStorage.getItem(KEY) === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export async function setNotify(on: boolean): Promise<boolean> {
  let ok = on;
  if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") ok = (await Notification.requestPermission()) === "granted";
  try {
    if (ok) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {}
  window.dispatchEvent(new Event(NOTIFY_EVENT));
  return ok;
}

/** Короткий мягкий сигнал (два тона) без файла — Web Audio. */
export function chime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.12);
      o.stop(now + i * 0.12 + 0.4);
    }
    setTimeout(() => void ctx.close(), 1000);
  } catch {}
}
