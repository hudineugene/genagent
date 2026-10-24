import { Bot, Mail, MessageCircle, MessageSquareText, Phone } from "lucide-react";
import { BRAND_PATHS } from "@/lib/brand-paths";
import { cx } from "@/components/ui";

/** Как выглядит значок канала: логотип приложения в фирменном цвете или знак для своих каналов. */
const LOOK: Record<string, { brand?: string; color: string; bg?: string }> = {
  telegram: { brand: "telegram", color: "#26A5E4" },
  whatsapp: { brand: "whatsapp", color: "#25D366" },
  instagram: { brand: "instagram", color: "#ffffff", bg: "linear-gradient(45deg, #FEDA75 0%, #FA7E1E 25%, #D62976 55%, #962FBF 80%, #4F5BD5 100%)" },
  threads: { brand: "threads", color: "#ffffff", bg: "#000000" },
  viber: { brand: "viber", color: "#7360F2" },
  messenger: { brand: "messenger", color: "#0866FF" },
  email: { color: "#F59E0B" },
  sms: { color: "#0EA5E9" },
  widget: { color: "#6366F1" },
  voice: { color: "#F97316" },
  api: { color: "#475569" },
};

/** Цвет канала для линий и картинок (PNG, отчёт). */
export const channelColor = (type: string) => (type === "instagram" ? "#D62976" : type === "threads" ? "#111111" : (LOOK[type]?.color ?? "#64748b"));

/**
 * Значок канала: настоящий логотип приложения (Telegram, WhatsApp, Instagram, Threads, Viber, Messenger; почта Gmail —
 * логотип Gmail), для своих каналов — знак. enabled=false — серый.
 */
export function ChannelIcon({ type, name = "", enabled = true, size = 32, className }: { type: string; name?: string; enabled?: boolean; size?: number; className?: string }) {
  const look = LOOK[type] ?? { color: "#64748b" };
  const gmail = type === "email" && /gmail\.com$/i.test(name.trim());
  const brand = gmail ? "gmail" : look.brand;
  const glyph = Math.round(size * 0.62);
  const style = { width: size, height: size, background: look.bg ?? (brand ? "#ffffff" : look.color) };
  const Icon = type === "email" ? Mail : type === "sms" ? MessageSquareText : type === "voice" ? Phone : type === "api" ? Bot : MessageCircle;
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-lg", brand && !look.bg && "border border-border", !enabled && "opacity-50 grayscale", className)} style={style} aria-hidden>
      {brand ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24">
          <path d={BRAND_PATHS[brand]} fill={gmail ? "#EA4335" : look.color} />
        </svg>
      ) : (
        <Icon className="text-white" style={{ width: glyph, height: glyph }} />
      )}
    </span>
  );
}
