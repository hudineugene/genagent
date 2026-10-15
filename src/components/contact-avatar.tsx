import { avatarColor } from "@/lib/contact";

/** Аватар собеседника: первая буква имени на цвете, который зависит от диалога. */
export function ContactAvatar({ id, label, size = 36 }: { id: string; label: string; size?: number }) {
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
