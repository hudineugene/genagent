/** Проверка ответов на выдуманные цифры (без базы и ИИ): npx tsx scripts/test-factcheck.ts */
import { unverifiedFacts } from "@/lib/agent/factcheck";

const kb = `Стікерпак 10 анімованих — 2 400 грн. Статичні 5 шт. — 700 грн. Телефон: +380 (67) 123-45-67.
Сайт yabotua.com, пошта hello@yabotua.com. Вілла Riviera — від 147 312 €. Знижка 10% на друге замовлення. Працюємо з 9:00 до 18:00.`;
const cases: [string, string[]][] = [
  ["10 анімованих коштують 2400 грн.", []],
  ["Вілла від 147.312 € — гарний варіант.", []],
  ["Дзвоніть: 067 123 45 67", []],
  ["Пишіть на hello@yabotua.com або на сайті yabotua.com", []],
  ["Ціна — 3 100 грн за пак.", ["3 100"]],
  ["Знижка 15% для нових клієнтів", ["15"]],
  ["Наш номер +380 50 999 11 22", ["+380 50 999 11 22"]],
  ["Детальніше на cheapstickers.com", ["cheapstickers.com"]],
  ["Відповімо за 10 хвилин, працюємо з 9:00 до 18:00, з 2019 року.", []],
];
let ok = true;
for (const [reply, expected] of cases) {
  const got = unverifiedFacts(reply, kb);
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  if (!pass) ok = false;
  console.log(pass ? "✓" : "✗", reply, "→", got);
}
process.exit(ok ? 0 : 1);
