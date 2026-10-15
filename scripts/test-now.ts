/** Время у компании в запросе агента: часовой пояс агента, только к последнему вопросу клиента.
 *  npx tsx scripts/test-now.ts */
import { nowLine } from "@/lib/agent/runtime";

const at = new Date("2026-10-15T19:40:00Z");
const kyiv = nowLine("Europe/Kyiv", at);
const madrid = nowLine("Europe/Madrid", at);
const fallback = nowLine(undefined, at);
const checks: Record<string, boolean> = {
  "Киев: четверг, 22:40": kyiv.includes("четверг") && kyiv.includes("22:40") && kyiv.includes("Europe/Kyiv"),
  "Мадрид: 21:40": madrid.includes("21:40") && madrid.includes("Europe/Madrid"),
  "без пояса — Киев": fallback.includes("22:40"),
  "помечено, что клиент этого не писал": kyiv.includes("Клиент этой строки не писал"),
};
console.log(checks);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
