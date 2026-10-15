import { DATA_DELETION_HTML } from "@/lib/legal/pages";

// Публичная страница для кабинета Meta: https://agents.yabotua.com/data-deletion
export function GET() {
  return new Response(DATA_DELETION_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
