import "server-only";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { normalizeText } from "./text";

const USER_AGENT = "Mozilla/5.0 (compatible; GenAgentBot/1.0; knowledge import)";
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|mp4|mp3|avi|mov|webm|css|js|json|xml|docx?|xlsx?|pptx?)$/i;

export type CrawledPage = { url: string; title: string; text: string };

/** Текст страницы: основное содержимое через Readability, иначе весь body без меню и скриптов. */
export function htmlToText(html: string, url: string): { title: string; text: string; links: string[] } {
  const { document } = parseHTML(html);
  const title = (document.querySelector("title")?.textContent ?? "").trim();

  const links: string[] = [];
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      links.push(new URL(a.getAttribute("href") ?? "", url || "http://localhost/").href);
    } catch {}
  }

  let text = "";
  try {
    const article = new Readability(document as unknown as Document).parse();
    text = article?.textContent ?? "";
  } catch {}
  if (text.trim().length < 200) {
    const { document: doc } = parseHTML(html);
    for (const el of doc.querySelectorAll("script, style, noscript, svg, nav, footer, header, iframe")) el.remove();
    text = doc.body?.textContent ?? "";
  }
  return { title, text: normalizeText(text), links };
}

async function fetchPage(url: string, signal?: AbortSignal) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html")) throw new Error(`not_html:${type}`);
  return { html: await res.text(), finalUrl: res.url || url };
}

function normalizeUrl(u: string) {
  const url = new URL(u);
  url.hash = "";
  for (const p of [...url.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(p)) url.searchParams.delete(p);
  return url.href.replace(/\/$/, "");
}

/**
 * Скачивает одну страницу или обходит сайт (только тот же домен) до `limit` страниц.
 */
export async function crawl(
  startUrl: string,
  mode: "page" | "site",
  opts: { limit?: number; onProgress?: (done: number) => void; signal?: AbortSignal } = {},
): Promise<CrawledPage[]> {
  const start = new URL(startUrl);
  if (!/^https?:$/.test(start.protocol)) throw new Error("bad_url");
  const limit = mode === "page" ? 1 : (opts.limit ?? 30);

  const queue = [normalizeUrl(start.href)];
  const seen = new Set(queue);
  const pages: CrawledPage[] = [];
  const texts = new Set<string>();
  let firstError: unknown = null;

  while (queue.length && pages.length < limit) {
    const batch = queue.splice(0, 4);
    const results = await Promise.allSettled(batch.map((u) => fetchPage(u, opts.signal)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        firstError ??= r.reason;
        return;
      }
      if (pages.length >= limit) return;
      const { title, text, links } = htmlToText(r.value.html, r.value.finalUrl);
      if (text.length > 80 && !texts.has(text)) {
        texts.add(text);
        pages.push({ url: batch[i], title: title || batch[i], text });
        opts.onProgress?.(pages.length);
      }
      if (mode === "site") {
        for (const link of links) {
          try {
            const u = new URL(link);
            if (u.hostname.replace(/^www\./, "") !== start.hostname.replace(/^www\./, "")) continue;
            if (!/^https?:$/.test(u.protocol) || SKIP_EXT.test(u.pathname)) continue;
            const n = normalizeUrl(u.href);
            if (!seen.has(n)) {
              seen.add(n);
              queue.push(n);
            }
          } catch {}
        }
      }
    });
  }

  if (!pages.length) {
    throw firstError instanceof Error ? firstError : new Error("empty");
  }
  return pages;
}

/** Склеивает страницы в один документ с заголовками разделов — по ним режутся фрагменты. */
export function pagesToDocument(pages: CrawledPage[]) {
  return pages.map((p) => `## ${p.title}\nСтраница: ${p.url}\n\n${p.text}`).join("\n\n");
}
