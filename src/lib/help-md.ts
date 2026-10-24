/** Разбор простой разметки справки (content/help.ts) в разделы для страницы «Помощь». */
export type HelpBlock =
  | { k: "p"; text: string }
  | { k: "h3"; text: string }
  | { k: "ul" | "ol"; items: string[] }
  | { k: "table"; head: string[]; rows: string[][] };

export type HelpSection = { id: string; title: string; blocks: HelpBlock[] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function slug(title: string, i: number) {
  const s = title.toLowerCase().replace(/[^a-zа-яёіїєґ0-9]+/gi, "-").replace(/^-|-$/g, "");
  return s || `s${i}`;
}

export function parseHelp(md: string): HelpSection[] {
  const sections: HelpSection[] = [{ id: "intro", title: "", blocks: [] }];
  let cur = sections[0];
  let list: Extract<HelpBlock, { k: "ul" | "ol" }> | null = null;
  let table: Extract<HelpBlock, { k: "table" }> | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const isList = /^- /.test(line) ? "ul" : /^\d+\. /.test(line) ? "ol" : null;
    if (!isList) list = null;
    if (!line.startsWith("|")) table = null;
    if (!line.trim()) continue;
    if (line.startsWith("## ")) {
      cur = { id: slug(line.slice(3), sections.length), title: line.slice(3).trim(), blocks: [] };
      sections.push(cur);
    } else if (line.startsWith("### ")) {
      cur.blocks.push({ k: "h3", text: line.slice(4).trim() });
    } else if (isList) {
      const text = line.replace(/^(- |\d+\. )/, "");
      if (!list || list.k !== isList) cur.blocks.push((list = { k: isList, items: [] }));
      list.items.push(text);
    } else if (line.startsWith("|")) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;
      if (!table) cur.blocks.push((table = { k: "table", head: cells(line), rows: [] }));
      else table.rows.push(cells(line));
    } else {
      cur.blocks.push({ k: "p", text: line.trim() });
    }
  }
  return sections.filter((s) => s.title || s.blocks.length);
}

/** Весь текст блока — для поиска. */
export function blockText(b: HelpBlock) {
  switch (b.k) {
    case "p":
    case "h3":
      return b.text;
    case "ul":
    case "ol":
      return b.items.join(" ");
    case "table":
      return [...b.head, ...b.rows.flat()].join(" ");
  }
}
