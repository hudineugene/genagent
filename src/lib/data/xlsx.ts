import "server-only";
import { inflateRawSync } from "node:zlib";

/**
 * Минимальное чтение Excel (.xlsx) без сторонних библиотек: zip → общие строки + первый (или названный) лист.
 * Даты Excel хранит числами — переводим в ДД.ММ.ГГГГ по стилю ячейки (встроенные и пользовательские форматы дат).
 */
type Entry = { name: string; method: number; size: number; offset: number };

function entries(buf: Buffer): Entry[] {
  // Конец центрального каталога: сигнатура 0x06054b50 в последних 64 КБ
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not_xlsx");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("not_xlsx");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nameLen), method, size, offset });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

function read(buf: Buffer, e: Entry): string {
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extra = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extra;
  const data = buf.subarray(start, start + e.size);
  return (e.method === 0 ? data : inflateRawSync(data)).toString("utf8");
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Номер столбца по ссылке ячейки: A → 0, AB → 27 */
function colIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const DATE_BUILTIN = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function excelDate(serial: number) {
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  const pad = (x: number) => String(x).padStart(2, "0");
  const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return serial % 1 ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

/** Листы книги по порядку. */
export function xlsxSheets(buf: Buffer): string[] {
  const files = entries(buf);
  const wb = files.find((e) => e.name === "xl/workbook.xml");
  if (!wb) throw new Error("not_xlsx");
  return [...read(buf, wb).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescape(m[1]));
}

/** Значения листа строками (первая — заголовок). sheet — название листа, по умолчанию первый. */
export function readXlsx(buf: Buffer, sheet?: string, maxRows = 20_000): string[][] {
  const files = entries(buf);
  const get = (name: string) => files.find((e) => e.name === name);
  const wbEntry = get("xl/workbook.xml");
  if (!wbEntry) throw new Error("not_xlsx");
  const wb = read(buf, wbEntry);
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: unescape(m[1].match(/\bname="([^"]*)"/)?.[1] ?? ""), rid: m[1].match(/r:id="([^"]*)"/)?.[1] ?? "" }));
  const target = (sheet ? sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase()) : sheets[0]) ?? sheets[0];
  const relsEntry = get("xl/_rels/workbook.xml.rels");
  const rels = relsEntry ? read(buf, relsEntry) : "";
  const relTarget = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]).find((a) => a.includes(`Id="${target?.rid}"`))?.match(/Target="([^"]*)"/)?.[1];
  const sheetPath = relTarget ? (relTarget.startsWith("/") ? relTarget.slice(1) : `xl/${relTarget.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  const sheetEntry = get(sheetPath) ?? get("xl/worksheets/sheet1.xml");
  if (!sheetEntry) throw new Error("not_xlsx");

  const sstEntry = get("xl/sharedStrings.xml");
  const shared = sstEntry
    ? [...read(buf, sstEntry).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")))
    : [];
  // Стили: какие индексы стиля ячейки — даты
  const stylesEntry = get("xl/styles.xml");
  const dateStyles = new Set<number>();
  if (stylesEntry) {
    const styles = read(buf, stylesEntry);
    const custom = new Set([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].filter((m) => /[dy]/i.test(m[2].replace(/"[^"]*"|\[[^\]]*\]/g, ""))).map((m) => Number(m[1])));
    const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].forEach((m, i) => {
      const fmt = Number(m[1].match(/numFmtId="(\d+)"/)?.[1] ?? 0);
      if (DATE_BUILTIN.has(fmt) || custom.has(fmt)) dateStyles.add(i);
    });
  }

  const out: string[][] = [];
  for (const rm of read(buf, sheetEntry).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (out.length >= maxRows + 1) break;
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]*)"/)?.[1];
      const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
      const inner = cm[2] ?? "";
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = unescape([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else if (v != null) value = !type && dateStyles.has(style) && !Number.isNaN(Number(v)) ? excelDate(Number(v)) : unescape(v);
      const idx = ref ? colIndex(ref) : row.length;
      while (row.length < idx) row.push("");
      row[idx] = value;
    }
    out.push(row);
  }
  return out;
}
