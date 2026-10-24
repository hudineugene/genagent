import "server-only";
import { withKeys } from "@/lib/keys";
import { apiKey } from "@/lib/keys";
import { generateJson } from "@/lib/llm/anthropic";
import { logUsage } from "@/lib/usage";
import { DEFAULT_MODEL, parseModelId } from "@/lib/models";
import { SKILLS } from "./skills";
import { REPLY_LANGUAGES, TONES, type AgentConfig } from "./types";
import type { ClientContext } from "./compile";

type Generated = {
  name: string;
  icon: string;
  role: string;
  description: string;
  skills: string[];
  tone: AgentConfig["tone"];
  toneCustom: string;
  replyLanguage: AgentConfig["replyLanguage"];
  rules: string;
  handoff: string;
  greeting: string;
  knowledgeTemplate: string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "icon",
    "role",
    "description",
    "skills",
    "tone",
    "toneCustom",
    "replyLanguage",
    "rules",
    "handoff",
    "greeting",
    "knowledgeTemplate",
  ],
  properties: {
    name: { type: "string", description: "Короткое имя агента для списка в студии, 2–4 слова" },
    icon: { type: "string", description: "Один эмодзи" },
    role: { type: "string", description: "Роль агента в именительном падеже, например «администратор клиники»" },
    description: { type: "string", description: "Задача агента и результат, к которому он ведёт клиента, 2–4 предложения" },
    skills: { type: "array", items: { type: "string", enum: SKILLS.map((s) => s.key) } },
    tone: { type: "string", enum: [...TONES] },
    toneCustom: { type: "string", description: "Описание тона, только если tone = custom, иначе пустая строка" },
    replyLanguage: { type: "string", enum: [...REPLY_LANGUAGES] },
    rules: { type: "string", description: "Правила: что можно и нельзя, по одному на строку, начиная с «- »" },
    handoff: { type: "string", description: "Когда передавать диалог менеджеру, через запятую" },
    greeting: { type: "string", description: "Первое сообщение агента клиенту" },
    knowledgeTemplate: {
      type: "string",
      description:
        "Заготовка базы знаний: список разделов с пустыми местами [заполнить], которые студия должна заполнить фактами. Не выдумывай цены и факты.",
    },
  },
} as const;

const SYSTEM = `Ты — архитектор ИИ-агентов в студии, которая делает чат-агентов для бизнеса (сайт, Telegram, Instagram, Threads).
По брифу менеджера студии собери конфигурацию агента для клиента студии.
Доступные навыки (выбирай только нужные, 2–5 штук):
${SKILLS.map((s) => `- ${s.key}: ${s.name.ru} — ${s.description.ru}`).join("\n")}
Пиши все текстовые поля на языке брифа. Не выдумывай факты о компании: цены, адреса и условия оставляй как [заполнить] в knowledgeTemplate.`;

async function generateAgentConfig__(brief: string, client: ClientContext & { id: string }) {
  const key = apiKey("anthropic");
  if (!key) throw new Error("Не задан ANTHROPIC_API_KEY в .env");

  const prompt = `Клиент студии: ${client.name}
Сфера: ${client.industry || "—"}
Сайт: ${client.website || "—"}
О компании: ${client.description || "—"}
Голос бренда: ${client.brandVoice || "—"}

Бриф на агента:
${brief}`;

  const { data: g, usage, model } = await generateJson<Generated>(key, parseModelId(DEFAULT_MODEL).model, {
    system: SYSTEM,
    prompt,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  await logUsage({ source: "generate", model, usage, clientId: client.id }).catch(() => {});

  const validSkills = new Set(SKILLS.map((s) => s.key));
  const config: Partial<AgentConfig> = {
    icon: g.icon || "🤖",
    role: g.role,
    description: g.description,
    skills: g.skills.filter((k) => validSkills.has(k)),
    tone: g.tone,
    toneCustom: g.toneCustom,
    replyLanguage: g.replyLanguage,
    rules: g.rules,
    handoff: g.handoff,
    greeting: g.greeting,
    knowledge: g.knowledgeTemplate,
  };
  return { name: g.name || "Агент", config };
}

/** generateAgentConfig — в области ключей клиента (его ключи ИИ, если заданы). */
export async function generateAgentConfig(...a: Parameters<typeof generateAgentConfig__>): ReturnType<typeof generateAgentConfig__> {
  return withKeys({ clientId: a[1].id }, () => generateAgentConfig__(...a));
}
