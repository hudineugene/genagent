import { cx } from "./ui";

/**
 * Фото сотрудника (из профиля) или буква на мягком фоне акцента. v — версия фото (0 — фото нет: без запроса к серверу).
 */
export function UserAvatar({ id, name, v, size = 32, className }: { id: string; name: string; v?: number; size?: number; className?: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  if (v)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- фото из своего маршрута
      <img src={`/api/avatar/${id}?v=${v}`} alt="" width={size} height={size} className={cx("shrink-0 rounded-full object-cover ring-1 ring-border", className)} style={{ width: size, height: size }} />
    );
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent", className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {letter}
    </span>
  );
}
