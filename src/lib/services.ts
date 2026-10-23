import "server-only";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Внешние платные сервисы, которые владелец подключает сам из админки (без правки сервера):
 * поиск в интернете для агентов (Anthropic, оплата за каждый поиск), ключ OpenAI (распознавание и озвучивание
 * голосовых, модели OpenAI), ключ Google Maps (маршруты — для модулей логистики).
 * Ключи из админки дополняют secrets.env: если ключ задан на сервере, он главнее.
 */
const KEY = "services";

export type ServicesSettings = {
  webSearch: { enabled: boolean; maxUses: number };
  openaiKey?: string;
  googleMapsKey?: string;
};

const DEFAULTS: ServicesSettings = { webSearch: { enabled: false, maxUses: 3 } };

/** Ключи, которые были на сервере до подстановки из админки (их не трогаем). */
const g = globalThis as unknown as { __envOpenAI?: string | undefined; __envMaps?: string | undefined; __servicesInit?: boolean };
if (!g.__servicesInit) {
  g.__servicesInit = true;
  g.__envOpenAI = process.env.OPENAI_API_KEY;
  g.__envMaps = process.env.GOOGLE_MAPS_API_KEY;
}

export async function getServices(): Promise<ServicesSettings> {
  const s = await getSetting<Partial<ServicesSettings>>(KEY);
  return { ...DEFAULTS, ...s, webSearch: { ...DEFAULTS.webSearch, ...s?.webSearch } };
}

/** Ключи из админки — в окружение процесса, чтобы ими пользовались озвучка, распознавание и модели OpenAI. */
export async function applyServiceKeys(s?: ServicesSettings) {
  const v = s ?? (await getServices());
  if (!g.__envOpenAI) {
    if (v.openaiKey) process.env.OPENAI_API_KEY = v.openaiKey;
    else delete process.env.OPENAI_API_KEY;
  }
  if (!g.__envMaps) {
    if (v.googleMapsKey) process.env.GOOGLE_MAPS_API_KEY = v.googleMapsKey;
    else delete process.env.GOOGLE_MAPS_API_KEY;
  }
}

/** Ключ задан на сервере (secrets.env) — в админке его не меняют. */
export function serverKeys() {
  return { openai: Boolean(g.__envOpenAI), maps: Boolean(g.__envMaps) };
}

export async function saveServices(patch: Partial<ServicesSettings>) {
  const next = { ...(await getServices()), ...patch };
  await setSetting(KEY, next);
  await applyServiceKeys(next);
  return next;
}

/** Поиск в интернете для агента: включён и у агента, и в админке. */
export async function webSearchFor(config: { webSearch?: boolean; model: string }) {
  if (!config.webSearch || !config.model.startsWith("anthropic:")) return undefined;
  const s = await getServices();
  return s.webSearch.enabled ? { maxUses: s.webSearch.maxUses } : undefined;
}
