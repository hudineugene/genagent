import { PRIVACY_HTML } from "@/lib/legal/pages";

// Публичная страница для кабинета Meta: https://agents.yabotua.com/privacy
export function GET() {
  return new Response(PRIVACY_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
