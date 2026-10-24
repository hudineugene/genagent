import { CHANNEL_LABEL, GROUPS, MODULES, type Ctx } from "@/lib/agent/map-modules";
import type { AgentConfig } from "@/lib/agent/types";
import type { MapChannel } from "./canvas";
import { channelColor } from "./channel-icon";
import { BRAND_PATHS } from "@/lib/brand-paths";

const BRAND_TYPES: Record<string, string> = { telegram: "telegram", whatsapp: "whatsapp", instagram: "instagram", threads: "threads", viber: "viber", messenger: "messenger" };
const LETTER: Record<string, string> = { email: "@", sms: "SMS", widget: "W", voice: "☎", api: "API" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Схема агента картинкой PNG — для встречи с владельцем бизнеса или презентации: каналы → ядро → модули.
 * Рисуется заново из данных (SVG → canvas), поэтому не зависит от размера экрана и темы.
 */
export async function downloadMapPng(opts: { config: AgentConfig; agentName: string; coreLines: { k: string; v: string }[]; channels: MapChannel[]; ctx: Ctx | null; locale: "ru" | "uk"; fileName: string; title: string }) {
  const { config, locale } = opts;
  const W = 1400;
  const pad = 40;
  const colCh = { x: pad, w: 240 };
  const colCore = { x: 340, w: 260 };
  const colMods = { x: 680, w: W - 680 - pad };
  const row = 30;
  const top = 110;
  const ink = "#111827";
  const muted = "#6b7280";
  const line = "#c7d2fe";
  const accent = "#4f46e5";

  const parts: string[] = [];
  const box = (x: number, y: number, w: number, h: number, stroke = "#e5e7eb", fill = "#ffffff", r = 14, sw = 1.5) => parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
  const text = (x: number, y: number, s: string, size = 15, color = ink, weight = 400) => parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${esc(s)}</text>`);
  const dot = (x: number, y: number, color: string) => parts.push(`<circle cx="${x}" cy="${y}" r="5" fill="${color}"/>`);
  // Значок канала: логотип приложения (как на карте) или цветная плитка с буквой для своих каналов
  const icon = (x: number, y: number, c: MapChannel) => {
    const gmail = c.type === "email" && /gmail\.com$/i.test(c.name.trim());
    const brand = gmail ? "gmail" : BRAND_TYPES[c.type];
    const color = c.enabled ? channelColor(c.type) : "#94a3b8";
    if (brand) {
      const tileBg = c.type === "instagram" || c.type === "threads" ? color : "#ffffff";
      const glyph = c.type === "instagram" || c.type === "threads" ? "#ffffff" : gmail ? "#EA4335" : color;
      box(x, y, 28, 28, "#e5e7eb", tileBg, 7, 1);
      parts.push(`<path d="${BRAND_PATHS[brand]}" fill="${glyph}" transform="translate(${x + 5},${y + 5}) scale(0.75)"/>`);
    } else {
      box(x, y, 28, 28, color, color, 7, 1);
      parts.push(`<text x="${x + 14}" y="${y + 19}" font-size="11" fill="#ffffff" font-weight="700" text-anchor="middle">${esc(LETTER[c.type] ?? "•")}</text>`);
    }
  };
  const curve = (x1: number, y1: number, x2: number, y2: number, color = line, w = 2) => {
    const mx = (x1 + x2) / 2;
    parts.push(`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${w}"/>`);
  };

  // Модули: две колонки групп
  const half = (colMods.w - 20) / 2;
  const groupBoxes: { x: number; y: number; h: number }[] = [];
  const colY = [top, top];
  for (const g of GROUPS) {
    const mods = MODULES.filter((m) => m.group === g.key);
    const h = 44 + mods.length * row + 10;
    const c = colY[0] <= colY[1] ? 0 : 1;
    const x = colMods.x + c * (half + 20);
    const y = colY[c];
    groupBoxes.push({ x, y, h });
    colY[c] += h + 20;
    box(x, y, half, h);
    text(x + 16, y + 28, g.title[locale], 16, ink, 600);
    mods.forEach((m, i) => {
      const yy = y + 44 + i * row + 14;
      const on = m.on(config);
      const warn = on && opts.ctx && m.warn?.(config, opts.ctx);
      dot(x + 22, yy - 5, on ? (warn ? "#f59e0b" : "#10b981") : "#d1d5db");
      text(x + 36, yy, cut(m.title[locale], 34), 14, on ? ink : muted);
    });
  }
  const H = Math.max(colY[0], colY[1], top + opts.channels.length * 60 + 80, top + 260) + pad;

  // Ядро — по центру высоты
  const coreH = 70 + opts.coreLines.length * 24;
  const coreY = (H - coreH) / 2;
  box(colCore.x, coreY, colCore.w, coreH, accent, "#ffffff", 16, 2.5);
  text(colCore.x + 20, coreY + 34, cut(`${config.icon || ""} ${opts.agentName}`.trim(), 26), 17, ink, 700);
  opts.coreLines.forEach((r, i) => {
    text(colCore.x + 20, coreY + 66 + i * 24, r.k, 13, muted);
    text(colCore.x + 96, coreY + 66 + i * 24, cut(r.v, 22), 13, ink, 600);
  });
  for (const g of groupBoxes) curve(colCore.x + colCore.w, coreY + coreH / 2, g.x, g.y + 22, line, 2);

  // Каналы
  const chStart = (H - opts.channels.length * 60) / 2;
  opts.channels.forEach((c, i) => {
    const y = chStart + i * 60;
    box(colCh.x, y, colCh.w, 48, "#e5e7eb");
    icon(colCh.x + 10, y + 10, c);
    dot(colCh.x + 38, y + 38, c.enabled ? "#10b981" : "#d1d5db");
    text(colCh.x + 50, y + 21, CHANNEL_LABEL[c.type] ?? c.type, 14, ink, 600);
    text(colCh.x + 50, y + 38, cut(c.name, 24), 12, muted);
    curve(colCh.x + colCh.w, y + 24, colCore.x, coreY + coreH / 2, c.enabled ? line : "#e5e7eb", 2);
  });

  text(pad, 52, opts.title, 26, ink, 700);
  text(pad, 80, locale === "uk" ? "Канали → ядро агента → модули" : "Каналы → ядро агента → модули", 15, muted);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, Segoe UI, Arial, sans-serif"><rect width="100%" height="100%" fill="#f8fafc"/>${parts.join("")}</svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg_load"));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const g = canvas.getContext("2d")!;
    g.scale(scale, scale);
    g.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("png");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${opts.fileName}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    URL.revokeObjectURL(url);
  }
}
