/** Язык ответа по буквам — подсказка судье автотестов. npx tsx scripts/test-detect-language.ts */
import { detectLanguage } from "@/lib/tests/engine";

const checks: Record<string, boolean> = {
  "украинский": detectLanguage("Анімований стікерпак на 10 стікерів орієнтовно коштує 1 700 грн. Це орієнтир.") === "украинский",
  "русский": detectLanguage("Апартаменты в Riviera 1 стоят от 147 312 €. Подъезд рядом, этаж высокий.") === "русский",
  "английский": detectLanguage("Yes! We have two villas with private pools in Finestrat.").startsWith("английский"),
  "украинский с русским словом": detectLanguage("Дякую, Ірино! Передаю ваш запит співробітнику студії, він зв'яжеться з вами. Ещё").startsWith("украинский (есть"),
};
console.log(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
