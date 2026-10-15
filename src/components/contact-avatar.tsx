import { UserRound } from "lucide-react";
import { avatarColor } from "@/lib/contact";

/** Аватар собеседника: первая буква имени на цвете диалога; без имени (посетитель сайта) — значок человека. */
export function ContactAvatar({ id, label, size = 36, anonymous = false }: { id: string; label: string; size?: number; anonymous?: boolean }) {
  if (anonymous) {
    return (
      <span className="grid shrink-0 place-items-center rounded-full bg-surface-2 text-muted" style={{ width: size, height: size }}>
        <UserRound style={{ width: size * 0.45, height: size * 0.45 }} />
      </span>
    );
  }
  const letter = label.replace(/^@/, "").trim().charAt(0).toUpperCase();
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ background: avatarColor(id), width: size, height: size, fontSize: size * 0.4 }}
    >
      {letter || "?"}
    </span>
  );
}
