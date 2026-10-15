import "server-only";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Расшифровка голосовых сообщений на своём сервере — без внешних сервисов и оплаты за минуты.
 * Модель Whisper small (transformers.js, ONNX, ~250 МБ на диске, ~1,1 ГБ в памяти во время работы):
 * загружается при первом голосовом и выгружается после 10 минут без голосовых, чтобы не держать память.
 * Голосовые Telegram приходят в OGG/Opus — декодер (WebAssembly) лежит рядом с transformers.js в VENDOR_DIR.
 * Одновременно расшифровывается одно голосовое — остальные ждут очереди (сервер на 2 ядра).
 */
const MODEL = "onnx-community/whisper-small";
const RATE = 16000;
export const MAX_SECONDS = 120;
const IDLE_MS = 10 * 60 * 1000;

type Asr = ((audio: Float32Array, opts: object) => Promise<{ text: string } | { text: string }[]>) & {
  dispose?: () => Promise<void>;
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: ((inputs: object) => Promise<{ logits: { data: Float32Array } }>) & {
    generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  };
};
type TensorCtor = new (type: string, data: BigInt64Array, dims: number[]) => unknown;
type Loaded = { asr: Asr; Tensor: TensorCtor };

const g = globalThis as unknown as {
  __asr?: Promise<Loaded>;
  __asrIdle?: ReturnType<typeof setTimeout>;
  __asrQueue?: Promise<unknown>;
};

async function vendorImport<T>(mod: string): Promise<T> {
  // Имя модуля в переменной — чтобы сборщик не пытался положить библиотеку в бандл.
  const req = createRequire(path.join(process.cwd(), "noop.js"));
  const entry = req.resolve(mod, { paths: [process.env.VENDOR_DIR, process.cwd()].filter((p): p is string => !!p) });
  return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(entry).href)) as T;
}

function loadAsr(): Promise<Loaded> {
  return (g.__asr ??= (async () => {
    const tf = await vendorImport<{
      pipeline: (task: string, model: string, opts: object) => Promise<Asr>;
      env: { cacheDir: string };
      Tensor: TensorCtor;
    }>("@huggingface/transformers");
    tf.env.cacheDir = process.env.MODELS_DIR ?? "./data/models";
    return { asr: await tf.pipeline("automatic-speech-recognition", MODEL, { dtype: "q8" }), Tensor: tf.Tensor };
  })().catch((e) => {
    g.__asr = undefined;
    throw e;
  }));
}

function scheduleUnload() {
  if (g.__asrIdle) clearTimeout(g.__asrIdle);
  g.__asrIdle = setTimeout(() => {
    const p = g.__asr;
    g.__asr = undefined;
    void p?.then(({ asr }) => asr.dispose?.()).catch(() => {});
  }, IDLE_MS);
  g.__asrIdle.unref?.();
}

/** Смешать каналы в моно и привести к 16 кГц (среднее по окну — для речи достаточно). */
export function toMono16k(channels: Float32Array[], sampleRate: number): Float32Array {
  const len = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(len);
  for (const c of channels) for (let i = 0; i < len; i++) mono[i] += c[i] / channels.length;
  if (sampleRate === RATE) return mono;
  const ratio = sampleRate / RATE;
  const n = Math.floor(len / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.min(len, Math.floor((i + 1) * ratio)));
    let s = 0;
    for (let j = a; j < b; j++) s += mono[j];
    out[i] = s / (b - a);
  }
  return out;
}

async function decodeOgg(data: Uint8Array): Promise<Float32Array> {
  const { OggOpusDecoder } = await vendorImport<{
    OggOpusDecoder: new () => {
      ready: Promise<void>;
      decodeFile: (d: Uint8Array) => Promise<{ channelData: Float32Array[]; sampleRate: number; samplesDecoded: number }>;
      free: () => void;
    };
  }>("ogg-opus-decoder");
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const r = await decoder.decodeFile(data);
    if (!r.samplesDecoded) throw new Error("empty audio");
    return toMono16k(r.channelData, r.sampleRate);
  } finally {
    decoder.free();
  }
}

// Что Whisper «слышит» в тишине и шуме — субтитры из обучающих данных. Такое не считаем текстом.
const NOISE = [
  /^[\s.…!?,-]*$/,
  /^\s*\(?\[?(музыка|спокойная музыка|music|аплодисменты|смех|шум|тишина|silence)\]?\)?[\s.!]*$/i,
  /продолжение следует/i,
  /субтитр/i,
  /dimatorzok/i,
  /редактор субтитров/i,
  /спасибо за просмотр/i,
  /дякую за перегляд/i,
  /подпишись на канал|подписывайтесь на канал/i,
];

export function cleanTranscript(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || NOISE.some((r) => r.test(t))) return null;
  return t.slice(0, 2000);
}

export class AsrError extends Error {
  constructor(public reason: "bad_audio" | "too_long" | "unavailable") {
    super(reason);
  }
}

// Языки клиентов наших агентов. Whisper в transformers.js сам язык не определяет (без подсказки считает речь
// английской и переводит), поэтому выбираем его сами: один проход модели по первым 30 секундам (~2–3 с).
const LANGUAGES = ["ru", "uk", "en", "es", "pl", "de"];

async function detectLanguage({ asr, Tensor }: Loaded, pcm: Float32Array, hint?: string): Promise<string> {
  const gc = asr.model.generation_config;
  const { input_features } = await asr.processor(pcm.subarray(0, 30 * RATE));
  const ids = new Tensor("int64", BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]);
  const { logits } = await asr.model({ input_features, decoder_input_ids: ids });
  let best = hint ?? "uk";
  let bestScore = -Infinity;
  for (const code of LANGUAGES) {
    const id = gc.lang_to_id[`<|${code}|>`];
    if (id === undefined) continue;
    // подсказка бота (язык клиента в боте) решает только почти равные случаи — например, суржик
    const score = logits.data[id] + (code === hint ? 1 : 0);
    if (score > bestScore) [best, bestScore] = [code, score];
  }
  return best;
}

/** Голосовое (OGG/Opus из Telegram) → текст или null, если слов не разобрать. */
export async function transcribeOgg(
  data: Uint8Array,
  hint?: string,
): Promise<{ text: string | null; seconds: number; language?: string }> {
  let pcm: Float32Array;
  try {
    pcm = await decodeOgg(data);
  } catch (e) {
    if (e instanceof Error && /Cannot find module/.test(e.message)) throw new AsrError("unavailable");
    throw new AsrError("bad_audio");
  }
  const seconds = Math.round(pcm.length / RATE);
  if (seconds > MAX_SECONDS) throw new AsrError("too_long");

  const job = (g.__asrQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
    let loaded: Loaded;
    try {
      loaded = await loadAsr();
    } catch (e) {
      console.warn("speech recognition unavailable:", e instanceof Error ? e.message.slice(0, 200) : e);
      throw new AsrError("unavailable");
    }
    try {
      const language = await detectLanguage(loaded, pcm, hint && LANGUAGES.includes(hint) ? hint : undefined);
      const out = await loaded.asr(pcm, { task: "transcribe", chunk_length_s: 30, language });
      return { language, text: (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text) ?? "" };
    } finally {
      scheduleUnload();
    }
  });
  g.__asrQueue = job;
  const { language, text } = await job;
  return { text: cleanTranscript(text), seconds, language };
}
