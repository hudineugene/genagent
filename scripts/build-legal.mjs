// Собирает src/lib/legal/pages.ts из site-pages/privacy и site-pages/data-deletion —
// страницы, которые GenAgent отдаёт по адресам /privacy и /data-deletion (для кабинета Meta).
// После правки страниц в site-pages: node scripts/build-legal.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
// В GenAgent маршруты без «/» в конце.
const forApp = (s) => s.replaceAll('href="/data-deletion/"', 'href="/data-deletion"').replaceAll('href="/privacy/"', 'href="/privacy"');

const privacy = forApp(read("site-pages/privacy/index.html"));
const deletion = forApp(read("site-pages/data-deletion/index.html"));
if (/\[[^\]]*(Ім'я|місто)/.test(privacy + deletion)) throw new Error("В страницах остались подстановки [Ім'я Прізвище] / [місто]");

mkdirSync(new URL("src/lib/legal/", root), { recursive: true });
writeFileSync(
  new URL("src/lib/legal/pages.ts", root),
  `// Политика конфиденциальности и удаление данных студии YABOT — публичные страницы для кабинета Meta
// (agents.yabotua.com/privacy, /data-deletion). Источник — site-pages/*; после правки: node scripts/build-legal.mjs
export const PRIVACY_HTML = ${JSON.stringify(privacy)};

export const DATA_DELETION_HTML = ${JSON.stringify(deletion)};
`,
);
console.log("pages.ts собран:", privacy.length, deletion.length);
