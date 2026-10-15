/** Чистка текста: единые переводы строк, без лишних пробелов и пустых строк. */
export function normalizeText(s: string) {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Грубая оценка токенов для кириллицы и латиницы (≈3 символа на токен). */
export function estimateTokens(chars: number) {
  return Math.round(chars / 3);
}

/** До этого объёма вся база знаний кладётся в промпт целиком (с кэшированием), выше — поиск по фрагментам. */
export const FULL_CONTEXT_MAX_CHARS = 60_000;

const CHUNK_SIZE = 1400;

/**
 * Режет текст на фрагменты ~1400 символов по абзацам. Заголовок раздела («## …»),
 * под которым лежит фрагмент, повторяется в его начале — так фрагмент понятен сам по себе.
 */
export function chunkText(text: string, title: string): string[] {
  const paragraphs = text.split(/\n{2,}/).flatMap((p) => splitLong(p.trim())).filter(Boolean);
  const chunks: string[] = [];
  let heading = "";
  let current: string[] = [];
  let size = 0;

  const flush = () => {
    if (!current.length) return;
    const head = [title, heading].filter(Boolean).join(" — ");
    chunks.push(`${head ? `[${head}]\n` : ""}${current.join("\n\n")}`);
    // Перекрытие: последний короткий абзац переносим в следующий фрагмент.
    const last = current[current.length - 1];
    current = last.length < 300 ? [last] : [];
    size = current.reduce((n, p) => n + p.length, 0);
  };

  for (const p of paragraphs) {
    if (p.startsWith("## ")) {
      flush();
      current = [];
      size = 0;
      heading = p.slice(3).split("\n")[0].trim();
      const rest = p.split("\n").slice(1).join("\n").trim();
      if (rest) {
        current.push(rest);
        size += rest.length;
      }
      continue;
    }
    if (size + p.length > CHUNK_SIZE && current.length) flush();
    current.push(p);
    size += p.length;
  }
  flush();
  return dedupe(chunks);
}

function splitLong(p: string): string[] {
  if (p.length <= CHUNK_SIZE) return [p];
  const sentences = p.match(/[^.!?\n]+[.!?]*\s*/g) ?? [p];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > CHUNK_SIZE && buf) {
      out.push(buf.trim());
      buf = "";
    }
    buf += s;
    while (buf.length > CHUNK_SIZE) {
      out.push(buf.slice(0, CHUNK_SIZE));
      buf = buf.slice(CHUNK_SIZE);
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function dedupe(chunks: string[]) {
  const seen = new Set<string>();
  return chunks.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
}

const STOPWORDS = new Set(
  (
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между " +
    "і й та що він на я з як а то все вона так його але так ти к у же ви за б по тільки її мені було ось від мене ще ні о із йому тепер коли навіть ну або чи бути був до вас вже там потім себе нічого їй може вони тут де є треба ній для ми тебе їх ніж була сам щоб без чого раз теж собі під буде хто цей того тому цього який зовсім ним тут цьому один майже мій тим щоб неї зараз були куди навіщо всіх ніколи можна при два про інший хоч після над більше той через ці нас всього них яка багато три цю моя добре свою цієї перед іноді краще трохи такий їм завжди звичайно між " +
    "здравствуйте привет добрый день вечер утро скажите подскажите пожалуйста спасибо хочу хотел хотела можно нужно интересует вопрос стоит стоить сделать делаете есть бывает вітаю привіт добрий скажіть підкажіть будь ласка дякую хочу хотів хотіла потрібно цікавить питання сколько скільки коштує зробити робите буває " +
    "the and for are but not you all any can had her was one our out has have how its may who did get got what when where which why with this that from they them there their your about would could should will does into just than then also some been were hello please thanks"
  ).split(/\s+/),
);

/**
 * Строит FTS5-запрос по сообщению клиента: значимые слова, грубое «обрезание окончаний»
 * и поиск по началу слова (чистка → «чистк»* найдёт «чистку», «чистки»).
 */
export function buildFtsQuery(text: string): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => (w.length >= 3 || /\d/.test(w)) && !STOPWORDS.has(w),
  );
  const terms = new Set<string>();
  for (const w of words) {
    let stem = w;
    if (/^\p{L}+$/u.test(w)) {
      // Окончания в русском и украинском обычно 1–3 буквы: «зубов» → «зуб», «чистку» → «чист».
      const cut = w.length >= 8 ? 3 : w.length >= 5 ? 2 : w.length === 4 ? 1 : 0;
      stem = w.slice(0, Math.max(3, w.length - cut));
    }
    terms.add(stem.replace(/"/g, ""));
    if (terms.size >= 12) break;
  }
  if (!terms.size) return null;
  return [...terms].map((t) => `"${t}"*`).join(" OR ");
}
