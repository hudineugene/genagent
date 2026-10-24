/** Недавние страницы (в этом браузере): верхняя строка записывает путь, поиск Ctrl K показывает их первыми. */
export type RecentPage = { href: string; title: string };

const KEY = "recent-pages";

export function readRecent(): RecentPage[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentPage[];
    return Array.isArray(list) ? list.filter((x) => x && typeof x.href === "string" && typeof x.title === "string") : [];
  } catch {
    return [];
  }
}

export function rememberPage(page: RecentPage) {
  try {
    const list = [page, ...readRecent().filter((x) => x.href !== page.href)].slice(0, 8);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}
