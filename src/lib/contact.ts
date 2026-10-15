/** Имя собеседника для списков: имя, @ник или «Посетитель сайта #AB12» (по началу id диалога). */
export function contactLabel(
  c: { contactName: string; contactHandle: string; channelType: string; id: string },
  labels: { visitor: string; instagramUser: string },
) {
  const fallback = c.channelType === "instagram" ? labels.instagramUser : labels.visitor;
  return c.contactName || c.contactHandle || `${fallback} #${c.id.slice(0, 4).toUpperCase()}`;
}

// Цвет аватара собеседника — по диалогу (у одного клиента много собеседников, цвет клиента их не различает)
const AVATAR_COLORS = ["#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b"];
export function avatarColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** «17 ч», «5 мин», «2 дн» — сколько прошло с момента at. */
export function waited(at: Date, t: { home: { minutes: string; hours: string; days: string; justNow: string } }) {
  const min = Math.floor((Date.now() - new Date(at).getTime()) / 60_000);
  if (min < 1) return t.home.justNow;
  if (min < 60) return `${min} ${t.home.minutes}`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ${t.home.hours}` : `${Math.floor(h / 24)} ${t.home.days}`;
}
