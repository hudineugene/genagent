import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { canAccess } from "@/lib/access";
import { LOGO_DIR, readCustomLogo } from "@/lib/client-logo";
import { readBytes, readLimited, safeFetch } from "@/lib/agent/custom-tools";

/**
 * Логотип клиента для аватара: значок его сайта (apple-touch-icon, иначе icon, иначе /favicon.ico), скачанный
 * один раз и сохранённый на неделю. Нет сайта или значка — буква на цвете клиента (SVG), чтобы <img> всегда что-то показал.
 */
const DIR = LOGO_DIR;
const WEEK = 7 * 24 * 3600_000;
// SVG с чужого сайта не берём: открытый по прямой ссылке, он мог бы выполнить скрипт на нашем адресе
const IMAGE = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/;
const SAFE = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function letter(name: string, color: string) {
  const ch = esc((name.trim().charAt(0) || "?").toUpperCase());
  const bg = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#64748b";
  return new Response(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="${bg}"/><text x="20" y="26.5" text-anchor="middle" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="17" font-weight="600" fill="#fff">${ch}</text></svg>`,
    { headers: { "content-type": "image/svg+xml", "cache-control": "private, no-cache", ...SAFE } },
  );
}

async function fetchIcon(site: string): Promise<{ type: string; data: Buffer } | null> {
  let base: URL;
  try {
    base = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
  } catch {
    return null;
  }
  const candidates: string[] = [];
  try {
    const page = await safeFetch(base, { method: "GET", headers: { accept: "text/html" }, signal: AbortSignal.timeout(6000) });
    const html = page.ok ? await readLimited(page, 200_000) : "";
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const rel = (re: RegExp) => links.filter((l) => re.test(l.match(/rel=["']([^"']+)["']/i)?.[1] ?? "")).map((l) => l.match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean) as string[];
    candidates.push(...rel(/apple-touch-icon/i), ...rel(/(^|\s)icon(\s|$)/i), ...rel(/shortcut icon/i));
  } catch {}
  candidates.push("/favicon.ico");
  for (const href of candidates.slice(0, 4)) {
    try {
      const u = new URL(href, base);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      const r = await safeFetch(u, { method: "GET", headers: { accept: "image/*" }, signal: AbortSignal.timeout(6000) });
      const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!r.ok || !IMAGE.test(type)) {
        void r.body?.cancel().catch(() => {});
        continue;
      }
      const data = await readBytes(r, 300_000);
      if (data.length > 64) return { type, data };
    } catch {}
  }
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(clientId) || !(await canAccess("client", clientId))) return new Response("not found", { status: 404 });
  const [c] = await db.select({ name: clients.name, color: clients.color, website: clients.website }).from(clients).where(eq(clients.id, clientId));
  if (!c) return new Response("not found", { status: 404 });
  // Свой логотип из настроек клиента — главнее значка сайта
  const own = await readCustomLogo(clientId);
  if (own) return new Response(new Uint8Array(own.data), { headers: { "content-type": own.type, "cache-control": "private, no-cache", ...SAFE } });
  const file = path.join(DIR, clientId);
  try {
    const st = await fs.stat(`${file}.json`);
    const meta = JSON.parse(await fs.readFile(`${file}.json`, "utf8")) as { type: string | null; site: string };
    if (Date.now() - st.mtimeMs < WEEK && meta.site === c.website) {
      if (!meta.type) return letter(c.name, c.color);
      return new Response(new Uint8Array(await fs.readFile(file)), { headers: { "content-type": meta.type, "cache-control": "private, no-cache", ...SAFE } });
    }
  } catch {}
  const icon = c.website.trim() ? await fetchIcon(c.website.trim()) : null;
  await fs.mkdir(DIR, { recursive: true });
  if (icon) await fs.writeFile(file, icon.data);
  await fs.writeFile(`${file}.json`, JSON.stringify({ type: icon?.type ?? null, site: c.website }));
  if (!icon) return letter(c.name, c.color);
  return new Response(new Uint8Array(icon.data), { headers: { "content-type": icon.type, "cache-control": "private, no-cache", ...SAFE } });
}
