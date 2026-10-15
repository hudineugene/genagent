export type Provider = "anthropic" | "openai" | "openrouter";

export type ModelInfo = {
  /** "провайдер:id модели", например "anthropic:claude-opus-5-5" */
  id: string;
  provider: Provider;
  label: string;
  /** Цена за 1M токенов (вход / выход), USD — для оценки расходов. */
  price?: { input: number; output: number };
  note?: { ru: string; uk: string };
};

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

/** Переменная окружения с ключом для каждого провайдера. */
export const PROVIDER_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// Список легко расширять: для OpenRouter в конструкторе можно ввести любой id модели вручную.
export const MODELS: ModelInfo[] = [
  {
    id: "anthropic:claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    price: { input: 4, output: 20 },
    note: { ru: "Самая умная, для сложных продаж", uk: "Найрозумніша, для складних продажів" },
  },
  {
    id: "anthropic:claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    price: { input: 2, output: 10 },
    note: { ru: "Баланс качества и цены", uk: "Баланс якості та ціни" },
  },
  {
    id: "anthropic:claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    price: { input: 0.1, output: 0.5 },
    note: { ru: "Быстрая и дешёвая, для FAQ", uk: "Швидка й дешева, для FAQ" },
  },
  { id: "openai:gpt-5", provider: "openai", label: "GPT-5" },
  { id: "openai:gpt-5-mini", provider: "openai", label: "GPT-5 mini" },
  { id: "openrouter:google/gemini-2.5-pro", provider: "openrouter", label: "Gemini 2.5 Pro" },
  { id: "openrouter:google/gemini-2.5-flash", provider: "openrouter", label: "Gemini 2.5 Flash" },
];

export const DEFAULT_MODEL = "anthropic:claude-opus-5-5";

export function parseModelId(id: string): { provider: Provider; model: string } {
  const i = id.indexOf(":");
  const provider = id.slice(0, i) as Provider;
  if (i < 0 || !(provider in PROVIDER_LABELS)) {
    throw new Error(`Unknown model id: ${id}`);
  }
  return { provider, model: id.slice(i + 1) };
}

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
